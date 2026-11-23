// Maps to share said untrue things, and two trip maps had nothing to see. A two-city map put its hotel "2 min walk to
// the station" for a station 1.8 km away (the stay was found 2 min from the centre), and failed its own check for the
// stop it expected as "Sevilla" against the stop "Seville". A square looked up as "Main Market Square" was refused (its
// English name is "Main Square"), a hotel looked up by its name was pinned as another of its chain that shared one word
// of it, another as a hotel that shared only "Boutique", and a football match, looked up by its own name, was pinned on a
// residential street named like the opponent. A plan refused its days for two places pinned with no page, and was run
// again without its sights: every day empty, and the check passed. The castle the message named was lost: its pin was
// joined to a refused page with &&, nothing listed it as not found, and the one mark for a place the person named went
// on the square. The busy lookup said "retry later" with four minutes of the turn left. Now:
//  - a base line names the walk to the place its stay was found near, and the station by how far it is;
//  - a stop the map expects matches by the place it resolves to (a station of the city, by the city's names in every
//    language uw station found);
//  - a place looked up by its name matches only a candidate one of whose names, in any language it carries, holds every
//    word of it that tells it from another of its kind, and whose kind fits: by default for a named place, and with
//    --strict-name; the other names OpenStreetMap keeps are looked up when the search's names do not hold it;
//  - a street is never a venue, a sight or a place to stay a lookup names, and an event is looked up by its venue,
//    under its own name;
//  - a place pinned with no page is on its day, counted, marked not checked; a trip's plan takes its pinned sights with
//    or without --sights, and uw validate fails while every full day is empty and a place to see is pinned;
//  - uw new --asked keeps the places the person named: uw validate fails while one is neither pinned nor listed as not
//    found yet, and a mark "asked" goes only on one of them;
//  - a busy lookup says how much of the turn is left and to retry it now when it fits;
//  - uw validate ends with what is not done when it fails.
// Offline: the place search, the lodging search and the walking router are a local mock in this file; every cache is
// off (no page is read).
// Run: node --test tests/pins-and-plans.test.mjs
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
const { holdsName } = await lib('names.mjs');
const { uncovered } = await lib('expect.mjs');
const { NOT_CHECKED } = await lib('cmd-plan.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-pins-plans-'));

// ---------------------------------------------------------------------------
// The places, as OpenStreetMap has them (names, kinds and positions; the search's answer shape)
const KRAKOW = [19.937, 50.0614];
const SEVILLE = [-5.99534, 37.38863], SEVILLE_STATION = [-5.975206, 37.392092];
const GRANADA = [-3.599534, 37.1735], GRANADA_STATION = [-3.608628, 37.183694];
const PORTO = [-8.612931, 41.140754];
const MANCHESTER = [-2.245115, 53.479489];
const NAPLES = [14.248768, 40.835885];
const feat = (c, [osm_type, osm_id, osm_key, osm_value], name, more = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c },
  properties: { osm_type, osm_id, osm_key, osm_value, name, ...more } });
const inKrakow = (en) => (en ? { city: 'Krakow', district: 'Old Town', state: 'Lesser Poland Voivodeship', country: 'Poland', countrycode: 'PL' }
  : { city: 'Kraków', district: 'Stare Miasto', state: 'województwo małopolskie', country: 'Polska', countrycode: 'PL' });
const inPorto = (en, district = 'Centro Histórico do Porto') => ({ city: 'Porto', county: 'Porto', district, country: 'Portugal', countrycode: 'PT' });
const inSpain = (city, en) => ({ city: en && city === 'Sevilla' ? 'Seville' : city, state: en ? 'Andalusia' : 'Andalucía', country: en ? 'Spain' : 'España', countrycode: 'ES' });
const inManchester = { city: 'Manchester', county: 'Greater Manchester', state: 'England', country: 'United Kingdom', countrycode: 'GB' };
const inNaples = (en) => ({ city: en ? 'Naples' : 'Napoli', state: 'Campania', country: en ? 'Italy' : 'Italia', countrycode: 'IT' });

/** What the place search answers: `q` the query, `en` an English-names search, `tags` its kind filter. */
function answer(q, en, tags) {
  const places = tags.includes('place:city'), stations = tags.includes('railway:station');
  if (places) {
    if (q === 'Seville, Spain') return [feat(SEVILLE, ['R', 342563, 'place', 'city'], en ? 'Seville' : 'Sevilla', inSpain('Sevilla', en))];
    if (q === 'Granada, Spain') return [feat(GRANADA, ['R', 344685, 'place', 'city'], 'Granada', inSpain('Granada', en))];
    return [];
  }
  // a city whose station carries its local name only: found by that name
  if (stations) {
    if (q === 'Sevilla') return [feat(SEVILLE_STATION, ['N', 191262271, 'railway', 'station'], 'Sevilla - Santa Justa', inSpain('Sevilla', en))];
    if (q === 'Granada') return [feat(GRANADA_STATION, ['N', 7201979115, 'railway', 'station'], 'Granada', inSpain('Granada', en))];
    return [];
  }
  if (tags.length) return [];
  return {
    // the square a turn looked up by its English name: OpenStreetMap's English name is "Main Square"
    'Main Market Square, Kraków': [
      feat([19.937113, 50.061496], ['W', 201133718, 'place', 'square'], en ? 'Main Square' : 'Rynek Główny', inKrakow(en)),
      feat([19.935799, 50.06184], ['N', 3802095803, 'amenity', 'police'], 'Komisariat Policji I w Krakowie', inKrakow(en)),
      feat([19.935485, 50.061343], ['W', 1378031423, 'highway', 'pedestrian'], en ? 'Main Square' : 'Rynek Główny', inKrakow(en)),
    ],
    // hotels looked up by their names: other hotels of a chain, or that share a word of the name
    'The Editory House Ribeira Porto Hotel, Porto': [
      feat([-8.61159, 41.148304], ['W', 226664554, 'tourism', 'hotel'], 'The Editory Boulevard Hotel', inPorto(en, 'Zona Histórica do Porto')),
      feat([-8.614039, 41.14135], ['N', 9174749551, 'tourism', 'hotel'], 'The House', inPorto(en)),
      feat([-8.601036, 41.150967], ['N', 12826028201, 'tourism', 'hotel'], 'The Editory Garden Baixa Porto Hotel', inPorto(en, 'Bonfim')),
      feat([-8.613272, 41.141369], ['W', 459626365, 'tourism', 'hostel'], 'The Central House Porto Ribeira', inPorto(en)),
    ],
    'Descobertas Boutique Hotel Porto, Porto': [
      feat([-8.613002, 41.144437], ['W', 266654329, 'tourism', 'hotel'], 'OCA Flores Hotel Boutique', inPorto(en, 'Zona Histórica do Porto')),
      feat([-8.604613, 41.154472], ['N', 9593978917, 'tourism', 'hotel'], 'Pur Oporto Boutique Hotel', inPorto(en)),
    ],
    // the hotel the search knows by a shorter name; OpenStreetMap keeps its full name as another of its names
    'Pestana Vintage Porto, Porto': [feat([-8.613186, 41.140495], ['W', 99101, 'tourism', 'hotel'], 'Hotel Pestana', inPorto(en))],
    'Hotel Carris Porto Ribeira, Porto': [feat([-8.6125, 41.1412], ['N', 99102, 'tourism', 'hotel'], 'Hotel Carris Porto Ribeira', inPorto(en))],
    // a match against Brentford: the search finds the street named like the opponent
    'Manchester United v Brentford, Manchester': [feat([-2.209717, 53.508077], ['W', 4956606, 'highway', 'residential'], 'Brentford Street', { ...inManchester, district: 'Harpurhey' })],
    'Brentford, Manchester': [feat([-2.209717, 53.508077], ['W', 4956606, 'highway', 'residential'], 'Brentford Street', { ...inManchester, district: 'Harpurhey' })],
    'Old Trafford, Manchester': [feat([-2.291337, 53.463097], ['W', 4956700, 'leisure', 'stadium'], 'Old Trafford', { ...inManchester, district: 'Stretford' })],
  }[q] || [];
}
// the other names OpenStreetMap keeps for an object (an Overpass lookup by id)
const OSM_TAGS = { 'way/99101': { tourism: 'hotel', name: 'Hotel Pestana', alt_name: 'Pestana Vintage Porto' } };
// places to stay, for uw stay (an Overpass lodging search around its point)
const LODGING = [
  { id: 371350062, c: [-5.995822, 37.38942], name: 'Hotel Plaza' },
  { id: 13710741053, c: [-3.599852, 37.173343], name: 'Hotel Victoria' },
  { id: 4313149323, c: [14.247602, 40.8424], name: 'Hotel Toledo' },
  { id: 9941, c: [19.93529, 50.060995], name: 'Palladian' },
];
const searched = [];
let mock;
before(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    // a place search and an Overpass that are both busy
    if (u.pathname.startsWith('/busy/')) { req.on('data', () => {}); req.on('end', () => { res.statusCode = 504; res.end('<html>504 Gateway Timeout</html>'); }); return; }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      const q = u.searchParams.get('q') || '';
      searched.push(q);
      res.end(JSON.stringify({ type: 'FeatureCollection', features: answer(q, u.searchParams.get('lang') === 'en', u.searchParams.getAll('osm_tag')) }));
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('/table/v1/')) {
      const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
      const d = pts.map((p) => haversine(pts[0], p) * 1.2);
      res.end(JSON.stringify({ code: 'Ok', durations: [d.map((m) => m / 1.25)], distances: [d] }));
      return;
    }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' ')) + decodeURIComponent(u.searchParams.get('data') || '');
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        let elements = [];
        if (/"tourism"~/.test(q)) elements = LODGING.filter(near).map((e) => ({ type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: { tourism: 'hotel', name: e.name } }));
        else for (const m of q.matchAll(/\b(node|way|relation)\((\d+)\)/g)) if (OSM_TAGS[`${m[1]}/${m[2]}`]) elements.push({ type: m[1], id: Number(m[2]), tags: OSM_TAGS[`${m[1]}/${m[2]}`] });
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

/** A uw command; `clock`: a host's turn clock; `busy`: the place search and Overpass answer 504. */
const uw = (args, { input = null, clock = null, busy = false, env: more = {} } = {}) => new Promise((resolve) => {
  const base = busy ? `${mock.url}/busy` : mock.url;
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: base, UW_OVERPASS: `${base}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_NO_CACHE: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_TURN_BUDGET', 'UW_TURN_GAP', 'UW_HANDOFF_STEP', 'UW_PLAN_DRAFT', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  if (clock) Object.assign(env, { INSTAFY_TURN_STARTED_AT: clock.started, INSTAFY_TURN_DEADLINE: clock.deadline });
  Object.assign(env, more);
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 120000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
/** A host turn of ten minutes with `usedS` seconds used (the pack keeps two minutes of it for the reply). */
const hostClock = (usedS) => ({ started: new Date(Date.now() - usedS * 1000).toISOString(), deadline: new Date(Date.now() + (600 - usedS) * 1000).toISOString() });
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const writeCfg = (site, cfg) => fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
const layerOf = (site, id) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features; } catch { return []; } };
const ok = (r) => { assert.equal(r.code, 0, r.out + r.err); return r; };
const itemsOf = (d, layer = 'sights') => d.items.filter((it) => it.ref?.layer === layer);
/** A place to see at a point, with its own page or none. */
const pinAt = (site, { id, name, at, stop, page = null }, more = {}) => uw(['add-point', site, '--layer', 'sights', '--at', at.join(','), '--name', name, '--id', id, '--props-file', '-'],
  { input: JSON.stringify({ stop, ...(page ? { source_url: page, source: new URL(page).hostname } : {}), ...more }) });

// ---------------------------------------------------------------------------
test('a place\'s own names hold the name it was looked up by: every word that tells it apart, in any language it carries; its kind words and titles aside', () => {
  const krakow = ['Kraków', 'Stare Miasto', 'Polska'], porto = ['Porto', 'Centro Histórico do Porto', 'Portugal'];
  // the square: its English name is made of the words of the name it was looked up by, the first and the last
  assert.equal(holdsName('Main Market Square, Kraków', ['Rynek Główny', 'Main Square'], krakow, { type: 'place=square' }), true);
  assert.equal(holdsName('Old Town', ['Old Town Hall'], krakow, { type: 'amenity=townhall' }), true, 'the words of the name, held');
  assert.equal(holdsName('Old Town Hall', ['Stare Miasto', 'Old Town'], krakow, { type: 'place=quarter' }), false, 'a hall in the old town is not the old town');
  // another hotel of the chain, a hotel that shares only "Boutique": not the hotel looked up
  assert.equal(holdsName('The Editory House Ribeira Porto Hotel, Porto', ['The Editory Boulevard Hotel'], porto, { type: 'tourism=hotel' }), false);
  assert.equal(holdsName('Descobertas Boutique Hotel Porto, Porto', ['OCA Flores Hotel Boutique'], porto, { type: 'tourism=hotel' }), false);
  assert.equal(holdsName('Pestana Vintage Porto, Porto', ['Hotel Pestana', 'Pestana Vintage Porto'], porto, { type: 'tourism=hotel' }), true, 'by another of its names');
  // the place a query names after its comma is where the place is, never a word of its name
  assert.equal(holdsName('Hotel Indigo Lisbon, Lisbon', ['Hotel Indigo'], ['Lisboa'], { type: 'tourism=hotel' }), true);
  // a match against a club is not the street named like the opponent: the country's name keeps "United" a word of it
  assert.equal(holdsName('Manchester United v Brentford, Manchester', ['Brentford Street'], ['Manchester', 'Harpurhey', 'United Kingdom'], { type: 'highway=residential' }), false);
  // a word of the place's kind is judged by its kind, a title in one language and not another by neither
  assert.equal(holdsName('Wawel Castle', ['Zamek Królewski na Wawelu'], krakow, { type: 'historic=castle' }), true);
  assert.equal(holdsName('Royal Alcázar of Seville', ['Real Alcázar de Sevilla', 'Alcázar of Seville'], ['Sevilla', 'Seville', 'Spain'], { type: 'historic=castle' }), true);
  assert.equal(holdsName("Saint Paul's Cathedral", ["St Paul's Cathedral"], ['London']), true);
  // a holiday flat named after the cathedral holds its name: its kind is why it is refused (below)
  assert.equal(holdsName('Granada Cathedral', ['Edificio cathedral'], ['Granada', 'España'], { type: 'tourism=apartment' }), true);
  // a branch of a hotel chain written without spaces is not another branch
  assert.equal(holdsName('康橋商旅南西館', ['康橋商旅北門館']), false);
  assert.equal(holdsName('康橋商旅南西館', ['康橋商旅南西館']), true);
  // nothing to tell by: never a refusal of its own
  assert.equal(holdsName('Central Station, Amsterdam', ['Amsterdam Centraal'], ['Amsterdam'], { type: 'railway=station' }), null);
});

test('a hotel looked up by its name is that hotel or "Not found yet", never another of its chain or one that shares a word of it; one of its other names holds it', async () => {
  const site = 'porto';
  ok(await uw(['new', site, '--title', 'Hotels in Ribeira', '--ask', 'Which hotel in Ribeira?', '--center', PORTO.join(','), '--zoom', '15']));
  const hotel = (query, id) => uw(['add-point', site, '--layer', 'hotels', '--query', query, '--near', PORTO.join(','), '--id', id, '--json']);
  const editory = await hotel('The Editory House Ribeira Porto Hotel, Porto', 'editory-house');
  assert.equal(editory.code, 2, editory.out + editory.err);
  assert.equal(editory.json.refused, 'name_mismatch');
  const text = await hotel('The Editory House Ribeira Porto Hotel, Porto', 'editory-house');
  assert.match(text.err, /^REFUSED: no candidate's own name is "The Editory House Ribeira Porto Hotel": "The Editory Boulevard Hotel", "The Editory Garden Baixa Porto Hotel", "The Central House Porto Ribeira" only share a word of it \(a place looked up by its name is the place of that name, never another of its kind\):$/m);
  const descobertas = await hotel('Descobertas Boutique Hotel Porto, Porto', 'descobertas');
  assert.equal(descobertas.code, 2, descobertas.out + descobertas.err);
  // the hotel the search knows by a shorter name: OpenStreetMap's other names hold the full one
  const pestana = ok(await hotel('Pestana Vintage Porto, Porto', 'pestana-vintage'));
  assert.equal(pestana.json.chosen.name, 'Hotel Pestana');
  ok(await hotel('Hotel Carris Porto Ribeira, Porto', 'carris-ribeira'));
  // the hotels on the map are the ones looked up; the others read "Not found yet"
  assert.deepEqual(layerOf(site, 'hotels').map((f) => [f.properties.id, f.properties.name]), [['pestana-vintage', 'Hotel Pestana'], ['carris-ribeira', 'Hotel Carris Porto Ribeira']]);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['The Editory House Ribeira Porto Hotel', 'Descobertas Boutique Hotel Porto']);
  // the turn's own pick still takes a candidate as it is
  const picked = ok(await uw(['add-point', site, '--layer', 'hotels', '--query', 'The Editory House Ribeira Porto Hotel, Porto', '--near', PORTO.join(','), '--id', 'boulevard', '--pick', '1', '--json']));
  assert.equal(picked.json.chosen.name, 'The Editory Boulevard Hotel');
});

test('an event is pinned at the venue its listing names, under its own name and date, or reads "Not found yet"; never on a street named like it', async () => {
  const site = 'manchester';
  ok(await uw(['new', site, '--title', 'Manchester this weekend', '--ask', 'Which events this weekend?', '--center', MANCHESTER.join(','), '--zoom', '12']));
  const event = (query, more = []) => uw(['add-point', site, '--layer', 'events', '--query', query, '--near', MANCHESTER.join(','), '--id', 'match', ...more, '--json']);
  // looked up by its own name: refused before any lookup, and listed as not found under that name
  const before = searched.length;
  const own = await event('Manchester United v Brentford, Manchester', ['--name', 'Manchester United v Brentford']);
  assert.equal(own.code, 2, own.out + own.err);
  assert.equal(own.json.refused, 'item_by_its_name');
  assert.equal(searched.length, before, 'nothing was looked up');
  assert.match(own.json.next, /^uw add-point manchester --layer events --query "<the venue its listing names>, Manchester" --name "Manchester United v Brentford" --note "<its date>" --id match$/);
  assert.deepEqual(layerOf(site, 'events'), []);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Manchester United v Brentford']);
  // a word of it: the street named like the opponent is no venue
  const street = await event('Brentford, Manchester', ['--name', 'Manchester United v Brentford']);
  assert.equal(street.code, 2, street.out + street.err);
  assert.deepEqual([street.json.refused, street.json.found?.kind], ['named_after', 'street']);
  const text = await event('Brentford, Manchester', ['--name', 'Manchester United v Brentford']);
  assert.match(text.err, /^REFUSED: found a street named "Brentford Street" \[highway=residential\], not the venue "Brentford" \(a street is never a venue, a sight or a place to stay named like it\):$/m);
  assert.deepEqual(layerOf(site, 'events'), []);
  assert.equal(cfgOf(site).missing.length, 1, 'listed once');
  // its venue: pinned there under the event's own name, with its date, and the entry goes
  const pinned = ok(await event('Old Trafford, Manchester', ['--name', 'Manchester United v Brentford', '--note', 'Sat 29 Nov, 17:30']));
  assert.equal(pinned.json.chosen.type, 'leisure=stadium');
  assert.deepEqual(layerOf(site, 'events').map((f) => [f.properties.name, f.properties.note, f.properties.looked_up_as]), [['Manchester United v Brentford', 'Sat 29 Nov, 17:30', 'Old Trafford']]);
  assert.equal(cfgOf(site).missing, undefined);
  // with no name of its own, an item of a listing is not pinned at all
  const bare = await uw(['add-point', site, '--layer', 'events', '--query', 'Old Trafford, Manchester', '--near', MANCHESTER.join(','), '--id', 'venue']);
  assert.equal(bare.code, 2, bare.out + bare.err);
  assert.match(bare.err, /an item of a listing \(layer events\) is pinned at its venue under its own name/);
});

test('a two-city trip with each city\'s stop its station: the base lines walk to the centre they were found near, the station by how far it is, and the stop expected by its local name is the station\'s', async () => {
  const site = 'seville-granada';
  ok(await uw(['new', site, '--title', 'Four days in Seville & Granada', '--ask', 'Four days in Seville and Granada', '--center', SEVILLE.join(','), '--zoom', '8', '--expect', 'Sevilla:2,Granada:2']));
  const seville = ok(await uw(['station', site, '--city', 'Seville', '--country', 'Spain', '--nights', '2', '--json']));
  assert.deepEqual([seville.json.feature.id, seville.json.feature.name, seville.json.feature.station_of, seville.json.feature.station_of_local, seville.json.feature.centre_km],
    ['seville', 'Sevilla - Santa Justa', 'Seville', 'Sevilla', 1.8]);
  ok(await uw(['station', site, '--city', 'Granada', '--country', 'Spain', '--nights', '2']));
  // the stations are far from the centres: stays in town, as the guide has it
  ok(await uw(['stay', site, '--near', SEVILLE.join(','), '--near-label', 'the centre of Seville', '--stop', 'seville', '--kinds', 'hotel']));
  ok(await uw(['stay', site, '--near', GRANADA.join(','), '--near-label', 'the centre of Granada', '--stop', 'granada', '--kinds', 'hotel']));
  const SIGHTS = [
    { id: 'sev-cat', name: 'Cathedral of Seville', at: [-5.993141, 37.385915], stop: 'seville', page: 'https://www.catedraldesevilla.es/en/' },
    { id: 'sev-market', name: 'Mercado de Triana', at: [-6.00355, 37.38575], stop: 'seville', page: 'https://mercadodetrianasevilla.com/' },
    { id: 'sev-alcazar', name: 'Alcázar of Seville', at: [-5.990183, 37.383211], stop: 'seville', page: 'https://alcazarsevilla.org/' },
    { id: 'gran-market', name: 'Alcaicería', at: [-3.599191, 37.175363], stop: 'granada', page: 'https://en.wikipedia.org/wiki/Alcaicer%C3%ADa' },
    { id: 'gran-cat', name: 'Catedral de Granada', at: [-3.599214, 37.17646], stop: 'granada', page: 'https://catedraldegranada.com/' },
    { id: 'gran-albaicin', name: 'Albaicín', at: [-3.594667, 37.181569], stop: 'granada', page: 'https://en.wikipedia.org/wiki/Albaic%C3%ADn' },
    { id: 'gran-alhambra', name: 'Alhambra', at: [-3.58811, 37.176055], stop: 'granada', page: 'https://www.alhambra-patronato.es/en' },
  ];
  for (const s of SIGHTS) ok(await pinAt(site, s));
  const plan = () => uw(['plan', site, '--stops', 'stations', '--ids', 'seville,granada', '--nights', '2,2', '--start', '2026-11-23', '--stays', 'stays', '--sights', 'sights', '--per-day', '4']);
  // a day in Seville with one place: refused once; another place looked for and not found, the same plan keeps it
  assert.equal((await plan()).code, 2);
  assert.equal((await uw(['add-point', site, '--layer', 'sights', '--query', 'Torre del Oro, Sevilla', '--strict-name', '--near', SEVILLE.join(','), '--id', 'torre'])).code, 2);
  ok(await plan());
  const bases = cfgOf(site).plan.days.flatMap((d) => d.items.filter((it) => /^Base: /.test(it.text)).map((it) => it.text));
  assert.equal(bases.length, 2);
  assert.match(bases[0], /^Base: Hotel Plaza · \d+ min walk to the centre of Seville · 1\.8 km from the station: taxi or local bus$/);
  assert.match(bases[1], /^Base: Hotel Victoria · \d+ min walk to the centre of Granada · about 2\d min walk to the station$/);
  for (const b of bases) assert.doesNotMatch(b, /· \d+ min walk to the station/, 'never the walk to the centre as one to the station');
  // the check: "Sevilla" is the stop the station of Seville stands for, on its days
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.equal(v.json.status, 'valid');
  const text = await uw(['validate', site, '--signal']);
  assert.match(text.out.trim().split('\n').pop(), /^✓ seville-granada is valid( \(\d+ warning\(s\)\))?\.$/);
});

test('a stop expected by its local name matches the station of the city it resolves to, by every name uw station found for it', () => {
  const station = { type: 'Feature', geometry: { type: 'Point', coordinates: SEVILLE_STATION },
    properties: { id: 'seville', name: 'Santa Justa', kind: 'train_station', station_of: 'Seville', station_of_local: 'Sevilla', nights: 2 } };
  const stay = { type: 'Feature', geometry: { type: 'Point', coordinates: [-5.995822, 37.38942] }, properties: { id: 'seville-plaza', name: 'Hotel Plaza', stop: 'seville', rank: 1 } };
  const layers = new Map([['stations', [station]], ['stays', [stay]]]);
  const cfg = { expect: [{ name: 'Sevilla', nights: 2 }], plan: { days: [
    { title: 'Mon 23 Nov · Seville', focus: { layer: 'stays', id: 'seville-plaza' }, items: [] },
    { title: 'Tue 24 Nov · Seville', focus: { layer: 'stays', id: 'seville-plaza' }, items: [] },
  ] } };
  assert.deepEqual(uncovered(cfg, layers), []);
  // a day focused on the stop's stay is its day, whatever its title says
  cfg.plan.days.forEach((d) => { d.title = d.title.replace('Seville', 'Andalusia'); });
  assert.deepEqual(uncovered(cfg, layers), []);
  // a stop the map does not have is still missing
  assert.deepEqual(uncovered({ ...cfg, expect: [{ name: 'Córdoba', nights: 1 }] }, layers).map((g) => [g.name, g.on_map]), [['Córdoba', false]]);
});

test('a trip\'s places pinned with no page land on their days, not checked: kept once more was looked for, taken by the plan with or without --sights; validate fails empty days while places to see are pinned', async () => {
  const site = 'naples';
  ok(await uw(['new', site, '--title', 'Three days in Naples', '--ask', 'Three days in Naples', '--center', NAPLES.join(','), '--zoom', '13', '--expect', 'Naples:3']));
  ok(await uw(['add-point', site, '--layer', 'stops', '--at', NAPLES.join(','), '--name', 'Naples', '--kind', 'city', '--id', 'naples', '--props', '{"nights":3}']));
  ok(await uw(['stay', site, '--near', '14.246423,40.841483', '--near-label', 'Quartieri Spagnoli', '--stop', 'naples', '--kinds', 'hotel']));
  // the museum and the cathedral pinned with no page (the museum's own site did not name it as the turn looked it up)
  ok(await pinAt(site, { id: 'mann', name: 'National Archaeological Museum of Naples', at: [14.25115, 40.853606], stop: 'naples' }));
  ok(await pinAt(site, { id: 'cathedral', name: 'Cathedral of the Assumption of Mary', at: [14.25987, 40.852653], stop: 'naples' }));
  ok(await pinAt(site, { id: 'galleria', name: 'Galleria Umberto I', at: [14.249745, 40.838586], stop: 'naples', page: 'https://en.wikipedia.org/wiki/Galleria_Umberto_I' }));
  const plan = (more = [], opts = {}) => uw(['plan', site, '--stops', 'stops', '--ids', 'naples', '--nights', '3', '--start', '2027-02-12', '--stays', 'stays', ...more], opts);
  const onDays = () => cfgOf(site).plan.days.map((d) => itemsOf(d).map((it) => [it.ref.id, it.check ?? null]));
  // one place a day: refused once, as a day with one place is; each place is on a day, the two with no page counted
  const first = await plan(['--sights', 'sights', '--json']);
  assert.equal(first.code, 2, first.out + first.err);
  assert.deepEqual(first.json.short_days.map((d) => d.places), [1, 1, 1]);
  assert.equal(first.json.no_page, undefined);
  assert.deepEqual(onDays().flat().map(([id]) => id).sort(), ['cathedral', 'galleria', 'mann']);
  assert.deepEqual(onDays().flat().filter(([, check]) => check === NOT_CHECKED).map(([id]) => id).sort(), ['cathedral', 'mann']);
  // more was looked for and none found: the same command keeps the days, the two sights on theirs
  assert.equal((await uw(['add-point', site, '--layer', 'sights', '--query', 'Naples Underground, Napoli', '--strict-name', '--near', NAPLES.join(','), '--id', 'underground'])).code, 2);
  const kept = ok(await plan(['--sights', 'sights', '--json']));
  assert.deepEqual(kept.json.kept_short.map((x) => x.places), [1, 1, 1]);
  assert.match(kept.json.days_for_the_reply, /National Archaeological Museum of Naples \(not checked\)/);
  assert.match(kept.json.days_for_the_reply, /Cathedral of the Assumption of Mary \(not checked\)/);
  // without --sights the plan takes them all the same
  const without = ok(await plan(['--json']));
  assert.deepEqual(without.json.plan.sights, ['sights']);
  assert.deepEqual(onDays().flat().map(([id]) => id).sort(), ['cathedral', 'galleria', 'mann']);
  const said = ok(await plan());
  assert.match(said.out, /^Places to see from the map's sights layer \(no --sights given: a trip's plan takes the places pinned to see; --sights names the layers\)\.$/m);
  // the check passes, warning of the days kept and of the places not checked
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  const warned = v.json.warnings.filter((w) => w.path === '$.plan.days').map((w) => w.message);
  assert.ok(warned.some((m) => /^2 places on the days are not checked on a page of their own: /.test(m)), warned.join('\n'));
  // a plan whose days were all written empty (an older pack's, or one made by hand) fails while places to see are pinned
  const cfg = cfgOf(site);
  delete cfg.plan.sights;
  for (const d of cfg.plan.days) d.items = d.items.filter((it) => /^Base: /.test(it.text));
  writeCfg(site, cfg);
  const empty = await uw(['validate', site, '--signal', '--json']);
  assert.equal(empty.code, 1, empty.out);
  const e = empty.json.errors.find((x) => /^every full day of the plan is empty while/.test(x.message));
  assert.equal(e?.message, 'every full day of the plan is empty while 3 places to see are pinned: National Archaeological Museum of Naples, Cathedral of the Assumption of Mary, Galleria Umberto I', JSON.stringify(empty.json.errors));
  assert.match(e.fix, /^uw plan naples … again puts them on their days \(a trip's plan takes the map's sights layer: --sights sights\); never leave them off the days$/);
  const text = await uw(['validate', site, '--signal']);
  assert.match(text.out.trim().split('\n').pop(), /^not done: every full day of the plan is empty while 3 places to see are pinned: .*\. The reply's first line says what is not done, never that the map is set or done\.$/);
});

test('the castle the person named: kept by uw new --asked, the mark only on it, pinned or listed even with the place search busy; the square pinned from its first lookup; the plan takes what it has', async () => {
  const site = 'krakow';
  ok(await uw(['new', site, '--title', '3 days in Kraków', '--ask', 'What to see each day in Kraków', '--center', KRAKOW.join(','), '--zoom', '13', '--expect', 'Kraków:3', '--asked', 'Wawel Castle']));
  assert.deepEqual(cfgOf(site).asked.map((a) => a.name), ['Wawel Castle']);
  ok(await uw(['add-point', site, '--layer', 'stops', '--at', KRAKOW.join(','), '--name', 'Kraków', '--kind', 'city', '--id', 'krakow', '--props', '{"nights":3}']));
  ok(await uw(['stay', site, '--near', KRAKOW.join(','), '--near-label', 'Old Town', '--stop', 'krakow', '--kinds', 'hotel']));
  // the square, by the name the turn had for it, from its first lookup; marked as named, which the person did not
  const square = await uw(['add-point', site, '--layer', 'sights', '--query', 'Main Market Square, Kraków', '--country', 'Poland', '--strict-name', '--near', KRAKOW.join(','), '--id', 'main-square', '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'krakow', asked: true }) });
  assert.equal(square.code, 0, square.out + square.err);
  assert.deepEqual([square.json.chosen.name, square.json.chosen.type], ['Rynek Główny', 'place=square']);
  assert.match(square.json.warnings.join('\n'), /not marked as a place the person named: they named "Wawel Castle", not "Main Market Square"/);
  assert.equal(layerOf(site, 'sights')[0].properties.asked, undefined);
  // the castle's pin never ran (joined to a refused page with &&): the check names it and the lookup to run
  const lost = await uw(['validate', site, '--signal', '--json']);
  assert.equal(lost.code, 1, lost.out);
  const asked = lost.json.errors.find((e) => e.path === '$.asked');
  assert.equal(asked?.message, 'a place the person named is neither on the map nor listed as not found yet: Wawel Castle', JSON.stringify(lost.json.errors));
  assert.match(asked.fix, /^pin it first, in a command of its own \(never after && behind uw cite: a refused page skips the pin\): uw add-point krakow --layer sights --query "Wawel Castle, Kraków" --strict-name --near <lng,lat> --props-file - with \{"asked":true,"stop":"<stop id>"\}/);
  // the place search busy, with time left in the turn: listed as not found yet, and the line says to retry it now
  const busy = await uw(['add-point', site, '--layer', 'sights', '--query', 'Wawel Royal Castle, Kraków', '--country', 'Poland', '--strict-name', '--near', KRAKOW.join(','), '--id', 'wawel', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'krakow', asked: true }), busy: true, clock: hostClock(200) });
  assert.equal(busy.code, 4, busy.out + busy.err);
  assert.match(busy.err, /kept "Wawel Royal Castle" listed as "Not found yet" on the map; the map works without it; about [45]m\d\ds left for tool work this turn: time to retry it once now, with: uw add-point krakow --layer sights --query 'Wawel Royal Castle, Kraków' .* --timeout 180$/m);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Wawel Royal Castle']);
  // too little of the turn left: the line says so, and what to offer
  const late = await uw(['add-point', site, '--layer', 'sights', '--query', 'Wawel Royal Castle, Kraków', '--country', 'Poland', '--strict-name', '--near', KRAKOW.join(','), '--id', 'wawel', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'krakow', asked: true }), busy: true, clock: hostClock(440) });
  assert.equal(late.code, 4, late.out + late.err);
  assert.match(late.err, /the map works without it; about 0m\d\ds left for tool work this turn, too little to retry it now: reply, and offer it as a follow-up \(uw add-point krakow .* --timeout \d+\)$/m);
  // the castle listed: the check has nothing to say of the places named; the plan takes what it has, the square on a day
  const planned = await uw(['plan', site, '--stops', 'stops', '--ids', 'krakow', '--nights', '3', '--start', '2026-11-23', '--stays', 'stays', '--sights', 'sights', '--json'], { busy: true, clock: hostClock(230) });
  assert.equal(planned.code, 0, planned.out + planned.err);
  assert.ok(cfgOf(site).plan.days.some((d) => itemsOf(d).some((it) => it.ref.id === 'main-square')), JSON.stringify(cfgOf(site).plan.days));
  const v = await uw(['validate', site, '--signal', '--json'], { clock: hostClock(240) });
  assert.deepEqual(v.json.errors.filter((e) => e.path === '$.asked'), []);
  assert.equal(v.json.status, v.code === 0 ? 'valid' : 'not done');
  // found once the search answers: pinned, the mark kept (the person named it), the entry gone
  const pinned = ok(await uw(['add-point', site, '--layer', 'sights', '--at', '19.9355,50.0541', '--name', 'Wawel Royal Castle', '--id', 'wawel', '--props-file', '-'], { input: JSON.stringify({ stop: 'krakow', asked: true }) }));
  assert.doesNotMatch(pinned.err, /not marked as a place the person named/);
  assert.equal(layerOf(site, 'sights').find((f) => f.properties.id === 'wawel').properties.asked, true);
  assert.equal(cfgOf(site).missing, undefined);
  // a later turn names another place: its mark stays, and it joins the places named
  const later = { started: new Date(Date.now() + 30000).toISOString(), deadline: new Date(Date.now() + 630000).toISOString() };
  ok(await uw(['add-point', site, '--layer', 'sights', '--at', '19.9447,50.0514', '--name', 'Kazimierz', '--id', 'kazimierz', '--props-file', '-'], { input: JSON.stringify({ stop: 'krakow', asked: true }), clock: later }));
  assert.equal(layerOf(site, 'sights').find((f) => f.properties.id === 'kazimierz').properties.asked, true);
  assert.deepEqual(cfgOf(site).asked.map((a) => a.name), ['Wawel Castle', 'Kazimierz']);
});
