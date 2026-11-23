// Trip maps pinned what nobody asked for, pinned a business for a sight, and one had no days. A map of "3 days, with
// one day around <an area> and <a place>" marked two places the person never named as named (they stood in for the
// area); a sight's lookup took a hotel named after it ("Hotel Castle Garden" for a bazaar), a restaurant on the quay
// it was named after (the street was found first), and a shop for a market hall, and the turn then removed the hotel
// and forced the plan; a not-found bridge was listed twice (looked up as "<name>, <city>", then as "<name> <city>");
// and a map whose plan was refused for days short of places, by a turn that never planned again, had no Plan tab. An
// events map waited on each event's own page though the listing it read named each one. Now:
//  - the trip guide marks only a place whose own name the message says; an area it names is a day's theme;
//  - a sight's lookup refuses a hotel, a restaurant or a shop named after it (unless the lookup asks for that kind, or
//    its own name is the query's), saying what it found, and takes the place itself when the search lists it; a
//    place has one "not found yet" entry, whatever wording or id it was looked up again under;
//  - a refused plan on a map with no days yet writes the days as they are (a draft the next run replaces), so a turn
//    that replies next leaves its Plan tab; uw add-point (and uw validate, for any other change) plans a draft again in
//    its turn once its places change, still a draft, keeping a day's own words, and each short day is named;
//  - the skill takes a listing it read as each item's source, each item pinned by its venue on an events layer, whose
//    items share the listing on a trip's map too, and whose venues are the businesses they name;
//  - on a trip of two stops or more, a place named with one stop's name is never the other stop's place of that name,
//    nor is a stop's own place a day trip town's of that name; a shop asked for as a sight by its own name (its
//    branch after it) is that shop, and a refusal never offers the business it refused as the place to pin.
// Offline: the place search, the lodging search and the walking router are a local mock in this file; every cache is
// off (no page is read).
// Run: node --test tests/named-kind-days.test.mjs
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
const { haversine } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'util.mjs')).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-named-kind-days-'));

// ---------------------------------------------------------------------------
// The city and what the place search answers there (OpenStreetMap names, kinds and positions, in its answer shape)
const CITY = [-8.6109, 41.1496];
const RIBEIRA = [-8.6131, 41.1407];
const AREA = { city: 'Porto', county: 'Porto', state: 'Porto', country: 'Portugal', countrycode: 'PT' };
const off = (c, dx, dy) => [Math.round((c[0] + dx / 84000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const hit = (c, osm, name, more = {}) => {
  const [osm_type, osm_id, osm_key, osm_value] = osm;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osm_type, osm_id, osm_key, osm_value, name, ...AREA, ...more } };
};
const ANSWERS = {
  // a hall whose only match is a hotel named after it
  'Bolhão Market Hall, Porto': [hit(off(CITY, 300, 400), ['N', 7001, 'tourism', 'hotel'], 'Hotel Bolhão Market')],
  // the quay, mapped as a street, first; then more of it, a bicycle park of its name, and a restaurant on it
  'Cais da Ribeira Porto': [
    hit(RIBEIRA, ['W', 7101, 'highway', 'pedestrian'], 'Cais da Ribeira'),
    hit(off(RIBEIRA, 40, 10), ['W', 7102, 'highway', 'living_street'], 'Cais da Ribeira'),
    hit(off(RIBEIRA, -60, 20), ['W', 7103, 'amenity', 'bicycle_parking'], 'Cais da Ribeira'),
    hit(off(RIBEIRA, 90, -30), ['N', 7104, 'amenity', 'restaurant'], 'O Cais da Ribeira'),
  ],
  // a market hall: a gift shop of its name in town, and the market of that name in another town
  'Mercado do Bolhão, Porto': [
    hit(off(CITY, 250, 350), ['N', 7201, 'shop', 'gift'], 'Lembranças do Mercado do Bolhão'),
    hit([-8.4265, 41.5503], ['W', 7202, 'amenity', 'marketplace'], 'Mercado do Bolhão', { city: 'Braga', county: 'Braga' }),
  ],
  // another market hall: its only match is a restaurant that takes its name
  'Mercado Ferreira Borges, Porto': [hit(off(CITY, -300, -500), ['N', 7203, 'amenity', 'restaurant'], 'Tasca do Mercado Ferreira Borges')],
  // a café asked for by its own name, with an article the café's name does not have
  'The Majestic, Porto': [hit(off(CITY, -100, 120), ['N', 7004, 'amenity', 'cafe'], 'Majestic')],
  // the venues of a listing's events
  'Praça da Ribeira, Porto': [hit(off(RIBEIRA, 120, 60), ['W', 7301, 'place', 'square'], 'Praça da Ribeira')],
  'Avenida dos Aliados, Porto': [hit(off(CITY, -40, 380), ['W', 7302, 'highway', 'pedestrian'], 'Avenida dos Aliados')],
  // a venue that is a business: a bar whose name adds its kind
  'Maus Hábito, Porto': [hit(off(CITY, 150, -60), ['N', 7311, 'amenity', 'bar'], 'Maus Hábito Bar')],
  // a shop asked for as a sight by its own name, its branch's name after it
  'A Vida Portuguesa, Porto': [hit(off(CITY, -360, -120), ['N', 7321, 'shop', 'gift'], 'A Vida Portuguesa Clérigos')],
  // named after a sight all the same: a shop whose added words say it is a shop, a holiday flat that starts with the
  // name of the hall it is named after
  'Serralves, Porto': [hit(off(CITY, -800, 300), ['N', 7331, 'shop', 'gift'], 'Serralves Gift Shop')],
  'Casa da Música, Porto': [hit(off(CITY, -700, 500), ['N', 7332, 'tourism', 'apartment'], 'Casa da Música View')],
  // a trip of one stop: its cathedral, looked up with no city (a day trip town's of that name is not found)
  'Sé Cathedral': [hit(off(CITY, 60, -330), ['W', 7342, 'amenity', 'place_of_worship'], 'Sé Cathedral')],
  // a trip of two stops: the other stop's cathedral (Porto's and the two old towns are not found)
  'Sé Cathedral Lisbon': [hit([-9.1335, 38.7097], ['W', 7341, 'amenity', 'place_of_worship'], 'Sé Cathedral', { city: 'Lisbon', county: 'Lisbon', state: 'Lisbon' })],
};
// the lodging search's answer by the quay
const LODGING = [
  { type: 'node', id: 7401, c: off(RIBEIRA, 150, 80), tags: { tourism: 'hotel', name: 'Hotel do Cais' } },
  { type: 'node', id: 7402, c: off(RIBEIRA, -120, 200), tags: { tourism: 'hotel', name: 'Hotel da Ribeira' } },
];

let mock;
before(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname.includes('/table/v1/')) {
      const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
      const d = pts.map((p) => haversine(pts[0], p) * 1.2);
      res.end(JSON.stringify({ code: 'Ok', durations: [d.map((m) => m / 1.25)], distances: [d] }));
      return;
    }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      const q = u.searchParams.get('q') || '';
      res.end(JSON.stringify({ type: 'FeatureCollection', features: u.searchParams.getAll('osm_tag').length ? [] : ANSWERS[q] || [] }));
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        const elements = /"tourism"~/.test(q) ? LODGING.filter(near).map((e) => ({ type: e.type, id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags })) : [];
        res.end(JSON.stringify({ elements }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mock = { server, url: `http://127.0.0.1:${server.address().port}` };
});
after(() => {
  mock?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

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
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
/** A host turn of ten minutes with `usedS` seconds used (the pack keeps two minutes of it for the reply). */
const hostClock = (usedS) => ({ started: new Date(Date.now() - usedS * 1000).toISOString(), deadline: new Date(Date.now() + (600 - usedS) * 1000).toISOString() });
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features; } catch { return []; } };
const flat = (rel) => fs.readFileSync(path.join(SKILL, rel), 'utf8').replace(/\s+/g, ' ');

const newMap = async (site, more = []) => {
  const r = await uw(['new', site, '--title', 'Porto', '--ask', 'What to see', '--center', CITY.join(','), '--zoom', '13', ...more]);
  assert.equal(r.code, 0, r.out + r.err);
};
const newTrip = async (site) => {
  await newMap(site, ['--expect', 'Porto:3']);
  const stop = await uw(['add-point', site, '--layer', 'stops', '--at', CITY.join(','), '--name', 'Porto', '--kind', 'city', '--id', 'porto', '--props', '{"nights":3}']);
  assert.equal(stop.code, 0, stop.out + stop.err);
  const stays = await uw(['stay', site, '--near', RIBEIRA.join(','), '--near-label', 'Ribeira', '--stop', 'porto', '--kinds', 'hotel']);
  assert.equal(stays.code, 0, stays.out + stays.err);
};
// the trip's places to see, each with its own page, a few minutes' walk apart
const SIGHTS = [
  { id: 'se', name: 'Porto Cathedral', at: off(CITY, 60, -330), page: 'https://www.diocese-porto.pt/se' },
  { id: 'clerigos', name: 'Clérigos Tower', at: off(CITY, -380, -150), page: 'https://www.torredosclerigos.pt/en/' },
  { id: 'bolsa', name: 'Palácio da Bolsa', at: off(RIBEIRA, -150, 90), page: 'https://palaciodabolsa.com/en/' },
  { id: 'lello', name: 'Livraria Lello', at: off(CITY, -420, -40), page: 'https://www.livrarialello.pt/en' },
  { id: 'aliados', name: 'Avenida dos Aliados', at: off(CITY, -40, 380), page: 'https://www.cm-porto.pt/aliados' },
];
const pin = (site, s, { env = {}, clock = null } = {}) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'],
  { input: JSON.stringify({ stop: 'porto', source_url: s.page, source: new URL(s.page).hostname.replace(/^www\./, ''), why: `see ${s.name}` }), env, clock });
const plan = (site, { force = false, clock = null } = {}) => uw(['plan', site, '--stops', 'stops', '--ids', 'porto', '--nights', '3', '--start', '2026-12-04',
  '--stays', 'stays', '--sights', 'sights', ...(force ? ['--force'] : []), '--json'], { clock });

// ---------------------------------------------------------------------------
test('the trip guide marks only a place whose own name the message says; an area it names is a day\'s theme', () => {
  const md = flat('reference/itinerary.md');
  assert.match(md, /3\. \*\*The places the message names\*\*, pinned first, each with `"asked":true` \(Phase B step 1\): only one whose own name the message says, never one you chose for an area it names\. Such an area \("a day around the old town"\) is a day's theme: that day's places come from it \(step 4\), unmarked, and its text starts with the area's name \(reword it after `uw plan`\)\. 4\. \*\*Places by area\*\*/);
  assert.doesNotMatch(md, /each with `"asked":true` \(Phase B step 1\); only those\./);
  // the config reference says what the mark is for in the same words
  assert.match(flat('reference/config.md'), /Only a place whose own name the message says is one: never one chosen for an area it names \(that area is a day's theme, its places unmarked\)\./);
});

const lookUp = (site, layer, query, id, more = []) => uw(['add-point', site, '--layer', layer, '--query', query, '--country', 'PT', '--near', CITY.join(','), '--id', id, ...more, '--json']);

test('a sight\'s lookup refuses a hotel named after it, saying what it found: nothing pinned, the place listed once as not found', async () => {
  const site = 'kinds-hotel';
  await newMap(site);
  const hall = await lookUp(site, 'sights', 'Bolhão Market Hall, Porto', 'market-hall', ['--strict-name']);
  assert.equal(hall.code, 2, hall.out + hall.err);
  assert.equal(hall.json.refused, 'named_after');
  assert.deepEqual(hall.json.found, { name: 'Hotel Bolhão Market', type: 'tourism=hotel', kind: 'lodging' });
  assert.match(hall.err, /^REFUSED: found a hotel named "Hotel Bolhão Market" \[tourism=hotel\], not the sight "Bolhão Market Hall" \(a hotel, a restaurant or a shop named after a place is not that place\):$/m);
  assert.match(hall.err, /^Retried once\? List it as unverified and add the next sight from the city page\.$/m);
  // the hint for a place mapped under another name never offers the business it just refused
  assert.match(hall.err, /In OpenStreetMap under another name \(one uw geocode finds by that name, never the business above\)\?/);
  assert.doesNotMatch(hall.err, /an object above/);
  assert.deepEqual(layerOf(site, 'sights'), [], 'no hotel pinned as a sight');
  assert.deepEqual(cfgOf(site).missing.map((m) => [m.name, m.id]), [['Bolhão Market Hall', 'market-hall']]);
  // so no wrong pin needs removing: the map is valid as it is
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  // a pick of it is the turn's own choice, and takes its entry off
  const picked = await lookUp(site, 'sights', 'Bolhão Market Hall, Porto', 'market-hall', ['--pick', '1']);
  assert.equal(picked.code, 0, picked.out + picked.err);
  assert.equal(cfgOf(site).missing, undefined);
  // a business named only with the query's words is the place asked for (a famous café, by its name)
  const cafe = await lookUp(site, 'sights', 'The Majestic, Porto', 'majestic', ['--strict-name']);
  assert.equal(cafe.code, 0, cafe.out + cafe.err);
  assert.deepEqual([cafe.json.chosen.name, cafe.json.chosen.type], ['Majestic', 'amenity=cafe']);
});

test('a quay is its street, never the restaurant on it; a lookup for food takes the restaurant', async () => {
  const site = 'kinds-quay';
  await newMap(site);
  // the street of the quay's name was found first: the restaurant within a few steps is not "the same place mapped twice"
  const quay = await lookUp(site, 'sights', 'Cais da Ribeira Porto', 'cais');
  assert.equal(quay.code, 0, quay.out + quay.err);
  assert.deepEqual([quay.json.chosen.name, quay.json.chosen.type], ['Cais da Ribeira', 'highway=pedestrian']);
  // a lookup that asks for that kind takes it: the restaurant on the quay is a food spot
  const food = await lookUp(site, 'food', 'Cais da Ribeira Porto', 'o-cais');
  assert.equal(food.code, 0, food.out + food.err);
  assert.deepEqual([food.json.chosen.name, food.json.chosen.type], ['O Cais da Ribeira', 'amenity=restaurant']);
});

test('a market hall whose only match nearby is a shop or a restaurant named after it is refused, saying what it found', async () => {
  const site = 'kinds-shop';
  await newMap(site);
  // (the market of that name is in another town, too far to be it)
  const market = await lookUp(site, 'sights', 'Mercado do Bolhão, Porto', 'bolhao');
  assert.equal(market.code, 2, market.out + market.err);
  assert.equal(market.json.refused, 'named_after');
  assert.deepEqual(market.json.found, { name: 'Lembranças do Mercado do Bolhão', type: 'shop=gift', kind: 'shop' });
  assert.match(market.err, /^REFUSED: found a shop named "Lembranças do Mercado do Bolhão" \[shop=gift\], not the sight "Mercado do Bolhão"/m);
  assert.deepEqual(layerOf(site, 'sights'), []);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Mercado do Bolhão']);
  // a restaurant that takes another hall's name, the only match: refused the same way, with or without --strict-name
  for (const more of [[], ['--strict-name']]) {
    const hall = await lookUp(site, 'sights', 'Mercado Ferreira Borges, Porto', 'ferreira-borges', more);
    assert.equal(hall.code, 2, hall.out + hall.err);
    assert.equal(hall.json.refused, 'named_after');
    assert.deepEqual(hall.json.found, { name: 'Tasca do Mercado Ferreira Borges', type: 'amenity=restaurant', kind: 'food' });
    assert.match(hall.err, /^REFUSED: found a restaurant named "Tasca do Mercado Ferreira Borges" \[amenity=restaurant\], not the sight "Mercado Ferreira Borges"/m);
  }
  assert.deepEqual(layerOf(site, 'sights'), [], 'no restaurant pinned as a sight');
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Mercado do Bolhão', 'Mercado Ferreira Borges'], 'each place listed once');
});

test('a place has one "not found yet" entry, whatever wording or id it was looked up again under; a pin under either takes it off', async () => {
  const site = 'once';
  await newTrip(site);
  // the bridge, looked up as "<name>, <city>" and again as "<name> <city>" under another id: the search has neither
  for (const [query, id] of [['Ponte Luís I, Porto', 'ponte'], ['Ponte Luís I Porto', 'bridge']]) {
    const r = await uw(['add-point', site, '--layer', 'sights', '--query', query, '--country', 'PT', '--strict-name', '--near', CITY.join(','), '--id', id]);
    assert.equal(r.code, 2, r.out + r.err);
  }
  const missing = cfgOf(site).missing;
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.deepEqual([missing[0].name, missing[0].id, missing[0].also.map((a) => [a.id, a.name])], ['Ponte Luís I', 'ponte', [['bridge', 'Ponte Luís I Porto']]]);
  // the second lookup says so
  const again = await uw(['add-point', site, '--layer', 'sights', '--query', 'Ponte Luís I Porto', '--country', 'PT', '--strict-name', '--near', CITY.join(','), '--id', 'bridge']);
  assert.match(again.err, /Listed on the map as "not found yet" once \(map\.config\.json "missing"\), with "Ponte Luís I": the same place, looked up before\./);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.also.length), [1], 'one entry, the later lookup kept on it once');
  // pinned under the second id (the coordinates the person gave): the one entry goes, and validate finds none beside it
  const pinned = await uw(['add-point', site, '--layer', 'sights', '--at', off(RIBEIRA, 400, -60).join(','), '--name', 'Luís I Bridge', '--id', 'bridge']);
  assert.equal(pinned.code, 0, pinned.out + pinned.err);
  assert.match(pinned.out, /removed its "not found yet" entry/);
  assert.equal(cfgOf(site).missing, undefined);
});

test('a refused plan leaves the days as they are on a map with none, so a reply right after it has the Plan tab; a place pinned since is on them at once, and each short day is named', async () => {
  const site = 'days';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 2)) assert.equal((await pin(site, s)).code, 0);
  // refused (two places for three days, while the turn has time): the map still gets the days, as they are
  const refused = await plan(site);
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.equal(refused.json.refused, 'days_short_of_places');
  assert.equal(refused.json.draft, true);
  assert.deepEqual(refused.json.short_days.map((d) => d.title), ['Fri 4 Dec · Porto', 'Sat 5 Dec · Porto', 'Sun 6 Dec · Porto']);
  // each day named, the short one as it is ("nothing to see yet"), for a reply that cannot wait
  assert.equal(refused.json.days_for_the_reply, 'Fri 4 Dec · Porto: nothing to see yet | Sat 5 Dec · Porto: Porto Cathedral | Sun 6 Dec · Porto: Clérigos Tower');
  assert.match(refused.err, /^REFUSED: 3 of 3 full days would have fewer than 2 places to see \(a full day takes 2-3\): .*\. The days are on the map as they are for now: a draft, which this command replaces\.$/m);
  // the last step before a reply: the Plan tab is there, each day on it
  const drafted = cfgOf(site).plan;
  assert.deepEqual(drafted.days.map((d) => d.title), ['Fri 4 Dec · Porto', 'Sat 5 Dec · Porto', 'Sun 6 Dec · Porto']);
  assert.equal(drafted.draft.start, '2026-12-04');
  // the next run replaces a draft without --force
  const rerun = await plan(site);
  assert.equal(rerun.code, 2, rerun.out + rerun.err);
  assert.doesNotMatch(rerun.err, /already has a "plan"/);

  // a place pinned after the draft: the pin plans the days again with it, still short (still a draft); validate last
  // names the days still short, and plans nothing again (nothing changed since)
  const third = await pin(site, SIGHTS[2]);
  assert.equal(third.code, 0, third.out + third.err);
  assert.match(third.out, /^Days planned again with it \(still short of places\): .*Palácio da Bolsa/m);
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.json.planned_again, undefined);
  const onDays = cfgOf(site).plan.days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.ref.id)).sort();
  assert.deepEqual(onDays, ['bolsa', 'clerigos', 'se']);
  assert.ok(cfgOf(site).plan.draft, 'still a draft');
  assert.equal(v.code, 1, 'the days still short fail while the turn has time');
  assert.ok(v.json.errors.some((e) => e.path === '$.plan.days' && /^3 of 3 full days have one place to see \(a full day takes 2-3 sourced places\): Fri 4 Dec · Porto, Sat 5 Dec · Porto, Sun 6 Dec · Porto$/.test(e.message)),
    JSON.stringify(v.json.errors, null, 1));
  const text = await uw(['validate', site, '--signal']);
  assert.doesNotMatch(text.out, /Days planned again/, 'nothing changed since: not planned again');

  // with too little time left, a place more: the pin plans the days again as they are, each short day named for the
  // reply by validate
  const late = hostClock(450);
  const fourth = await pin(site, SIGHTS[3], { clock: late });
  assert.equal(fourth.code, 0, fourth.out + fourth.err);
  assert.match(fourth.out, /^Days planned again with it: .*Livraria Lello/m);
  const last = await uw(['validate', site, '--signal', '--json'], { clock: late });
  assert.equal(last.code, 0, JSON.stringify(last.json?.errors ?? last.out, null, 1));
  assert.equal(last.json.planned_again, undefined);
  const w = last.json.warnings.filter((x) => x.path === '$.plan.days');
  assert.equal(w.length, 1, JSON.stringify(last.json.warnings, null, 1));
  assert.match(w[0].message, /^2 of 3 full days have one place to see: /);
  assert.equal(w[0].fix, 'too little time is left to add places in this turn; the reply names these days and offers to add places to them');
});

test('a draft is planned again only in the turn that wrote it, and a map whose days are already there keeps them when a plan is refused', async () => {
  const site = 'later';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 2)) assert.equal((await pin(site, s)).code, 0);
  assert.equal((await plan(site)).code, 2);
  const before = cfgOf(site).plan;
  // a later turn: the draft's days are the map's as they are (the person may have changed them), for a pin and for
  // validate
  const later = await pin(site, SIGHTS[2], { clock: hostClock(0) });
  assert.equal(later.code, 0, later.out + later.err);
  assert.doesNotMatch(later.out, /Days planned again/);
  const v = await uw(['validate', site, '--signal', '--json'], { clock: hostClock(0) });
  assert.equal(v.json.planned_again, undefined);
  assert.deepEqual(cfgOf(site).plan.days, before.days);
  // days written as they are (no draft), then a refused plan: they stay as they were, nothing written
  assert.equal((await plan(site, { force: true, clock: hostClock(450) })).code, 0);
  const final = cfgOf(site).plan;
  assert.equal(final.draft, undefined);
  const refused = await plan(site, { force: true });
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.equal(refused.json.draft, undefined);
  assert.match(refused.err, /^REFUSED: .*\. Nothing was written\.$/m);
  assert.deepEqual(cfgOf(site).plan, final);
});

test('a listing read is each item\'s source: the skill pins each by its venue, cited to the listing, and opens an item\'s own page only for what was asked', async () => {
  assert.match(flat('SKILL.md'), /A listing read \(what's on\) is each item's source: pin it by venue \(`--layer events --query "<venue>" --name "<item>"`, date in `note`\); its own page only for an asked value it lacks\./);
  // as it says: two events of one listing, each at its venue, both citing the listing; the map's sources name it
  const site = 'whats-on';
  await newMap(site);
  const listing = 'https://www.visitporto.travel/en/events';
  for (const [venue, name, id, when] of [['Praça da Ribeira, Porto', 'Christmas Market', 'market', 'Sat 5 – Sun 6 Dec'], ['Avenida dos Aliados, Porto', 'New Year Concert', 'concert', 'Thu 31 Dec, 22:00']]) {
    const r = await uw(['add-point', site, '--layer', 'events', '--query', venue, '--country', 'PT', '--near', CITY.join(','), '--name', name, '--id', id, '--props-file', '-'],
      { input: JSON.stringify({ source_url: listing, source: 'Visit Porto', note: when }) });
    assert.equal(r.code, 0, r.out + r.err);
  }
  const events = layerOf(site, 'events');
  assert.deepEqual(events.map((f) => [f.properties.name, f.properties.looked_up_as, f.properties.source_url, f.properties.note]), [
    ['Christmas Market', 'Praça da Ribeira', listing, 'Sat 5 – Sun 6 Dec'], ['New Year Concert', 'Avenida dos Aliados', listing, 'Thu 31 Dec, 22:00']]);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.match(v.json.sources_for_the_reply, /Visit Porto/);
});

// ---------------------------------------------------------------------------
// A trip of two stops, a listing's venues and items, a shop that is a sight, and a draft's days kept up to date
const LISBON = [-9.1393, 38.7223];
const newTwoStops = async (site) => {
  await newMap(site, ['--expect', 'Lisbon:3,Porto:2']);
  for (const [at, name, id, nights] of [[LISBON, 'Lisbon', 'lisbon', 3], [CITY, 'Porto', 'porto', 2]]) {
    const r = await uw(['add-point', site, '--layer', 'stops', '--at', at.join(','), '--name', name, '--kind', 'city', '--id', id, '--props', JSON.stringify({ nights })]);
    assert.equal(r.code, 0, r.out + r.err);
  }
};
const lookIn = (site, at, query, name, id, more = []) => uw(['add-point', site, '--layer', 'sights', '--query', query, '--country', 'PT', '--near', at.join(','),
  '--name', name, '--id', id, ...more]);

test('on a trip of two stops, a place of one name in each is two places: one\'s pin or lookup never takes the other\'s "not found yet" entry', async () => {
  const site = 'two-stops';
  await newTwoStops(site);
  // Porto's cathedral is not found; Lisbon's, looked up the same way, is pinned: Porto's stays listed
  assert.equal((await lookIn(site, CITY, 'Sé Cathedral Porto', 'Porto Cathedral', 'porto-se', ['--strict-name'])).code, 2);
  const lisbon = await lookIn(site, LISBON, 'Sé Cathedral Lisbon', 'Lisbon Cathedral', 'lisbon-se');
  assert.equal(lisbon.code, 0, lisbon.out + lisbon.err);
  assert.doesNotMatch(lisbon.out, /removed its "not found yet" entry/);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Porto Cathedral']);
  // looked up again, with Lisbon's on the map: still listed, never "on the map already" as Lisbon's
  const again = await lookIn(site, CITY, 'Sé Cathedral Porto', 'Porto Cathedral', 'porto-se', ['--strict-name']);
  assert.equal(again.code, 2, again.out + again.err);
  assert.doesNotMatch(again.err, /on the map already/);
  assert.match(again.err, /Listed on the map as "not found yet"/);
  // each city's old town, neither found: two entries
  assert.equal((await lookIn(site, LISBON, 'Old Town Lisbon', 'Old Town Lisbon', 'lisbon-old')).code, 2);
  const porto = await lookIn(site, CITY, 'Old Town Porto', 'Old Town Porto', 'porto-old');
  assert.equal(porto.code, 2, porto.out + porto.err);
  assert.doesNotMatch(porto.err, /the same place, looked up before/);
  assert.deepEqual(cfgOf(site).missing.map((m) => [m.name, m.also?.length ?? 0]), [['Porto Cathedral', 0], ['Old Town Lisbon', 0], ['Old Town Porto', 0]]);
  // and validate finds none of them on the map
  const v = await uw(['validate', site, '--json']);
  assert.ok(!v.json.errors.some((e) => e.path === '$.missing'), JSON.stringify(v.json.errors, null, 1));
});

test('on a trip of one stop, its own place pinned never takes a day trip town\'s place of that name off "not found yet"', async () => {
  const site = 'day-trip-town';
  await newTrip(site);
  // the day trip town's cathedral, named with its town after a comma, is not found
  const braga = await uw(['add-point', site, '--layer', 'daytrips', '--query', 'Sé Cathedral, Braga', '--country', 'PT', '--near', '-8.4265,41.5503', '--max-km', '80',
    '--name', 'Braga Cathedral', '--id', 'braga-se', '--strict-name']);
  assert.equal(braga.code, 2, braga.out + braga.err);
  // the stop's own, looked up with no city, is pinned: the town's stays listed, and validate finds it beside no pin
  const porto = await uw(['add-point', site, '--layer', 'sights', '--query', 'Sé Cathedral', '--country', 'PT', '--near', CITY.join(','), '--name', 'Porto Cathedral', '--id', 'porto-se']);
  assert.equal(porto.code, 0, porto.out + porto.err);
  assert.doesNotMatch(porto.out, /removed its "not found yet" entry/);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Braga Cathedral']);
  const v = await uw(['validate', site, '--json']);
  assert.ok(!v.json.errors.some((e) => e.path === '$.missing'), JSON.stringify(v.json.errors, null, 1));
});

test('which city a place is named in decides: the city after a comma or after the name, and a name with no city only on a map of one stop', async () => {
  const { sameMissing, pinNamesMissing, areaWords } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'missing.mjs')).href);
  const two = areaWords(['Lisbon', 'Porto'], [], { stops: 2 });
  const one = areaWords(['Porto'], [], { stops: 1 });
  const porto = { name: 'Porto Cathedral', query: 'Sé Cathedral, Porto', id: 'porto-se', layer: 'sights' };
  // two stops: each city's cathedral, its city after a comma or after its name
  assert.equal(sameMissing(porto, { name: 'Lisbon Cathedral', query: 'Sé Cathedral, Lisbon' }, two), false);
  assert.equal(sameMissing({ name: 'Porto Cathedral', query: 'Sé Cathedral Porto' }, { name: 'Lisbon Cathedral', query: 'Sé Cathedral Lisbon' }, two), false);
  assert.equal(pinNamesMissing(porto, { layer: 'sights', id: 'lisbon-se', names: ['Lisbon Cathedral'], query: 'Sé Cathedral, Lisbon' }, two), false);
  // one city's place looked up twice is one place on a trip of two stops too, and its pin takes its entry off
  assert.equal(sameMissing({ name: 'Ponte Luís I', query: 'Ponte Luís I, Porto' }, { name: 'Ponte Luís I Porto' }, two), true);
  assert.equal(pinNamesMissing(porto, { layer: 'sights', id: 'se', names: ['Sé Cathedral'], query: 'Sé Cathedral Porto' }, two), true);
  // a name with no city in it: the map's one city's on a map of one stop, either city's on a trip of two
  const bare = { layer: 'sights', id: 'se', names: ['Sé Cathedral'], query: null };
  assert.equal(pinNamesMissing({ ...porto, query: 'Sé Cathedral Porto' }, bare, one), true);
  assert.equal(pinNamesMissing({ ...porto, query: 'Sé Cathedral Porto' }, bare, two), false);
  // other towns named after a comma (a day trip's) are told apart on any map, from each other and from the stop's own
  // place looked up with no city: a pin of the stop's cathedral never takes the day trip town's entry off
  assert.equal(sameMissing({ name: 'A', query: 'Old Town, Braga' }, { name: 'B', query: 'Old Town, Guimarães' }, one), false);
  assert.equal(sameMissing({ name: 'A', query: 'Old Town, Braga' }, { name: 'B', query: 'Old Town, Braga, Portugal' }, one), true);
  assert.equal(sameMissing({ name: 'A', query: 'Old Town' }, { name: 'B', query: 'Old Town, Braga' }, one), false);
  assert.equal(pinNamesMissing({ name: 'Braga Cathedral', query: 'Sé Cathedral, Braga', id: 'braga-se', layer: 'sights' }, bare, one), false);
  // a map with no stop has no city of its own: a name with no city is the place of that name
  assert.equal(sameMissing({ name: 'Ponte Luís I' }, { name: 'B', query: 'Ponte Luís I, Porto' }, areaWords([], [], { stops: 0 })), true);
});

test('a listing\'s venue that is a business is the place; on a sight\'s layer a shop asked for by its own name is that shop, a business named after the sight is not', async () => {
  const site = 'venues';
  await newMap(site);
  // an event at a bar, looked up by the venue's name (not a sight's lookup): the bar
  const gig = await uw(['add-point', site, '--layer', 'events', '--query', 'Maus Hábito, Porto', '--country', 'PT', '--near', CITY.join(','), '--name', 'Jazz night', '--id', 'jazz', '--json']);
  assert.equal(gig.code, 0, gig.out + gig.err);
  assert.equal(gig.json.chosen.type, 'amenity=bar');
  // a shop asked for as a sight by its own name, with its branch's name after it
  const shop = await lookUp(site, 'sights', 'A Vida Portuguesa, Porto', 'vida', ['--strict-name']);
  assert.equal(shop.code, 0, shop.out + shop.err);
  assert.equal(shop.json.chosen.type, 'shop=gift');
  // named after the sight all the same: a shop whose added words say it is a shop; a holiday flat whose name starts
  // with the hall's (a place to stay is never the sight by its name's first words)
  for (const [query, id, found] of [['Serralves, Porto', 'serralves', 'Serralves Gift Shop'], ['Casa da Música, Porto', 'musica', 'Casa da Música View']]) {
    const r = await lookUp(site, 'sights', query, id);
    assert.equal(r.code, 2, r.out + r.err);
    assert.equal(r.json.refused, 'named_after');
    assert.equal(r.json.found.name, found);
  }
});

test('on a trip\'s map a listing\'s items share the listing as their source; two sights still never share a page', async () => {
  const site = 'trip-listing';
  await newTrip(site);
  const listing = 'https://www.visitporto.travel/en/events';
  for (const [venue, name, id, when] of [['Praça da Ribeira, Porto', 'Christmas Market', 'market', 'Sat 5 – Sun 6 Dec'], ['Avenida dos Aliados, Porto', 'New Year Concert', 'concert', 'Thu 31 Dec, 22:00']]) {
    const r = await uw(['add-point', site, '--layer', 'events', '--query', venue, '--country', 'PT', '--near', CITY.join(','), '--name', name, '--id', id, '--props-file', '-'],
      { input: JSON.stringify({ source_url: listing, source: 'Visit Porto', note: when }) });
    assert.equal(r.code, 0, r.out + r.err);
  }
  assert.deepEqual(layerOf(site, 'events').map((f) => f.properties.source_url), [listing, listing]);
  // a page two sights share is about a list of places: the second is refused, as before
  const guide = 'https://www.visitporto.travel/en/top-sights';
  const sight = (s) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'],
    { input: JSON.stringify({ stop: 'porto', source_url: guide, source: 'Visit Porto' }) });
  assert.equal((await sight(SIGHTS[0])).code, 0);
  const second = await sight(SIGHTS[1]);
  assert.equal(second.code, 2, second.out + second.err);
  assert.match(second.err, /is the page Porto Cathedral \(sights:se\) cites too/);
});

test('a place pinned after a refused plan is on the draft\'s days at once, with no uw validate before the reply, and the refusal\'s same command still runs', async () => {
  const site = 'draft-pins';
  await newTrip(site);
  // refused with no place to see yet: the days are a draft
  const refused = await plan(site);
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.equal(refused.json.draft, true);
  // the places pinned after it, then the reply (no plan, no validate): the days have them
  for (const s of SIGHTS.slice(0, 2)) {
    const r = await pin(site, s);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^Days planned again with it \(still short of places\): /m);
  }
  const onDays = cfgOf(site).plan.days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.ref.id)).sort();
  assert.deepEqual(onDays, ['clerigos', 'se']);
  assert.equal(cfgOf(site).plan.draft.start, '2026-12-04');
  // a place looked up by its name, as a turn pins it: on the days too, said in the command's JSON
  const looked = await uw(['add-point', site, '--layer', 'sights', '--query', 'Avenida dos Aliados, Porto', '--country', 'PT', '--near', CITY.join(','), '--id', 'aliados', '--json', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'porto', source_url: SIGHTS[4].page, source: 'cm-porto.pt' }) });
  assert.equal(looked.code, 0, looked.out + looked.err);
  assert.equal(looked.json.planned_again.short, true, JSON.stringify(looked.json.planned_again));
  assert.match(looked.json.planned_again.days_for_the_reply, /Avenida dos Aliados/);
  assert.ok(cfgOf(site).plan.days.some((d) => d.items.some((it) => it.ref?.id === 'aliados')), 'on a day');
  // a place removed: the days are planned again without it
  const removed = await uw(['set', site, 'sights:clerigos', '--remove']);
  assert.equal(removed.code, 0, removed.out + removed.err);
  assert.match(removed.out, /^Days planned again without it \(still short of places\): /m);
  assert.deepEqual(cfgOf(site).plan.days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.ref.id)).sort(), ['aliados', 'se']);
  // the refusal said to run the same command again: it still replaces the days, without --force
  const rerun = await plan(site);
  assert.equal(rerun.code, 2, rerun.out + rerun.err);
  assert.doesNotMatch(rerun.err, /already has a "plan"/);
});

test('a day\'s own words, written over a draft\'s, stay on their day when the draft is planned again, and are named', async () => {
  const site = 'draft-words';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 2)) assert.equal((await pin(site, s)).code, 0);
  assert.equal((await plan(site)).code, 2);
  // the turn words day 2 as the area it is for
  const cfgPath = path.join(tmp, site, 'map.config.json');
  const cfg = cfgOf(site);
  cfg.plan.days[1].text = 'Ribeira: the old town by the river';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // a place more, then validate: the days have it, and day 2 keeps its words
  const r = await pin(site, SIGHTS[2]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Day 2 keeps its own text: check it still fits its places\./);
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.json.planned_again, undefined, 'nothing changed since the pin planned them again');
  const days = cfgOf(site).plan.days;
  assert.equal(days[1].text, 'Ribeira: the old town by the river');
  assert.deepEqual(days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.ref.id)).sort(), ['bolsa', 'clerigos', 'se']);
});

test('uw validate plans a draft again with a place no lookup of the turn\'s own placed on its days, keeping a day\'s own words and naming them', async () => {
  const site = 'draft-validate';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 2)) assert.equal((await pin(site, s)).code, 0);
  assert.equal((await plan(site)).code, 2);
  const cfgPath = path.join(tmp, site, 'map.config.json');
  const cfg = cfgOf(site);
  cfg.plan.days[2].text = 'Clérigos and the bookshops of the upper town';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // a place pinned by a step of uw handoff --apply (which plans the days itself at its end): not planned again by it
  const step = await pin(site, SIGHTS[2], { env: { UW_HANDOFF_STEP: '1' } });
  assert.equal(step.code, 0, step.out + step.err);
  assert.doesNotMatch(step.out, /Days planned again/);
  // validate last: the days have it, still short (a draft the turn's uw plan replaces), and day 3 keeps its words
  const v = await uw(['validate', site, '--signal', '--json']);
  const days = cfgOf(site).plan.days;
  assert.deepEqual(days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.ref.id)).sort(), ['bolsa', 'clerigos', 'se']);
  assert.equal(days[2].text, 'Clérigos and the bookshops of the upper town');
  assert.equal(v.json.planned_again.short, true, JSON.stringify(v.json.planned_again));
  assert.deepEqual(v.json.planned_again.kept_texts, [3]);
  assert.ok(cfgOf(site).plan.draft, 'still a draft');
  // said in its text too
  const text = await uw(['validate', site, '--signal'], { env: {} });
  assert.doesNotMatch(text.out, /Days planned again/, 'nothing changed since');
});
