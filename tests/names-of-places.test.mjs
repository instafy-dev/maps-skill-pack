// A place is the place its name says, by whichever of its names a turn has. A castle the person named, pinned by its
// local name, lost its mark and failed the map's check as neither pinned nor listed, and each fix the tools named led
// back there; the same castle, looked up by its English name while the place search was slow and Overpass busy, was
// refused as "another of its kind". A theatre, a hotel or a market looked up by its name was pinned as another of its
// kind that shared a word but not its title, its "Central" or its code ("Teatro Español" for "Teatro Real"), and a
// hotel named with generic words only as one named with more ("Hotel Plaza de Armas" for "Hotel Plaza"). A boulevard
// looked up as a sight by its usual name was refused as a street. A day reached after a short ride, whose one place had
// no page, was said to have nothing to see though the plan counted it; a stop expected by the person's word for a city
// failed beside the station found by the city's local name. Now:
//  - a pin that takes off a "not found yet" entry goes by that entry's name, an "already pinned" answer to a lookup by
//    a name the person gave records that name on the pin, and every line that drops the mark names that fix;
//  - before a named place is refused, the search's English names are read even when it is slow; when neither they nor
//    OpenStreetMap's other names can be read, a sight sharing a word of its name is taken, and said (never a business);
//  - a name with a word of its own must carry the query's title, its words such as "Central", and its codes; a place to
//    stay, a venue or a business named with generic words only is the one of that very name;
//  - a sight that is a main road is that road by its usual name;
//  - validate counts a day's places as uw plan does; uw station keeps the city's English name too.
// Offline: the place search and Overpass are a local mock in this file; every cache is off.
// Run: node --test tests/names-of-places.test.mjs
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
const { holdsName } = await lib('names.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-names-of-places-'));

// ---------------------------------------------------------------------------
// The places, as OpenStreetMap has them
const KRAKOW = [19.937, 50.0614], CASTLE = [19.935, 50.054];
const PARIS = [2.3522, 48.8566], MADRID = [-3.7038, 40.4168], MANCHESTER = [-2.245115, 53.479489];
const SEVILLE = [-5.99534, 37.38863], SEVILLE_STATION = [-5.975206, 37.392092];
const feat = (c, [osm_type, osm_id, osm_key, osm_value], name, more = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c },
  properties: { osm_type, osm_id, osm_key, osm_value, name, ...more } });
const inKrakow = (en) => (en ? { city: 'Krakow', district: 'Old Town', state: 'Lesser Poland Voivodeship', country: 'Poland', countrycode: 'PL' }
  : { city: 'Kraków', district: 'Stare Miasto', state: 'województwo małopolskie', country: 'Polska', countrycode: 'PL' });
const inParis = { city: 'Paris', state: 'Île-de-France', country: 'France', countrycode: 'FR' };
const inMadrid = { city: 'Madrid', state: 'Comunidad de Madrid', country: 'España', countrycode: 'ES' };
const inSpain = (en) => ({ city: en ? 'Seville' : 'Sevilla', state: en ? 'Andalusia' : 'Andalucía', country: en ? 'Spain' : 'España', countrycode: 'ES' });
const inManchester = { city: 'Manchester', county: 'Greater Manchester', state: 'England', country: 'United Kingdom', countrycode: 'GB' };
// the castle: tagged an attraction; an English name only where `english` says so
const castle = (en, english) => feat(CASTLE, ['W', 12345, 'tourism', 'attraction'], en && english ? english : 'Zamek Królewski na Wawelu', inKrakow(en));
const hotelKrakow = (en) => feat([19.9361, 50.0555], ['N', 777, 'tourism', 'hotel'], 'Hotel Wawel Castle View', inKrakow(en));

/** What the place search answers: `q` the query, `en` an English-names search, `tags` its kind filter; `english` the
 *  castle's English name in this run (none: the search has none). */
function answer(q, en, tags, english) {
  if (tags.includes('place:city')) return q === 'Sevilla, Spain' ? [feat(SEVILLE, ['R', 342563, 'place', 'city'], en ? 'Seville' : 'Sevilla', inSpain(en))] : [];
  if (tags.includes('railway:station')) return q === 'Sevilla' ? [feat(SEVILLE_STATION, ['N', 191262271, 'railway', 'station'], 'Sevilla - Santa Justa', inSpain(en))] : [];
  if (tags.length) return [];
  return {
    'Wawel Castle, Kraków': [castle(en, english)],
    'Zamek Królewski na Wawelu, Kraków': [castle(en, english)],
    'Wawel Castle View, Kraków': [hotelKrakow(en)],
    'Wawel Palace Hotel, Kraków': [hotelKrakow(en)],
    // a theatre, a hotel looked up by their names: others of their kind that share a word
    'Teatro Real, Madrid': [
      feat([-3.7006, 40.4146], ['N', 501, 'amenity', 'theatre'], 'Teatro Español', inMadrid),
      feat([-3.6977, 40.4177], ['N', 502, 'amenity', 'theatre'], 'Teatro de la Zarzuela', inMadrid),
    ],
    'Hotel Plaza, Sevilla': [feat([-6.0006, 37.3925], ['N', 601, 'tourism', 'hotel'], 'Hotel Plaza de Armas', inSpain(en))],
    // a boulevard known by its short name, and a residential street named like a word of a query
    'Champs-Élysées, Paris': [feat([2.3076, 48.8698], ['W', 701, 'highway', 'primary'], 'Avenue des Champs-Élysées', inParis)],
    'Brentford, Manchester': [feat([-2.209717, 53.508077], ['W', 4956606, 'highway', 'residential'], 'Brentford Street', { ...inManchester, district: 'Harpurhey' })],
  }[q] || [];
}
const OSM_TAGS = { 'way/12345': { tourism: 'attraction', name: 'Zamek Królewski na Wawelu' } };

let mock;
before(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    const busy = () => { req.on('data', () => {}); req.on('end', () => { res.statusCode = 504; res.end('<html>504 Gateway Timeout</html>'); }); };
    // /<english>/<state>/api/: the castle's English name in this run ("-": none); state "en-busy": the English search
    // answers 504; "busy" on Overpass: it answers 504
    const [, english = '-', state = 'ok'] = (u.pathname.match(/^\/([^/]+)\/([^/]+)\//) || []);
    const rest = u.pathname.replace(/^\/[^/]+\/[^/]+/, '');
    if (rest === '/api/' || rest === '/api') {
      const en = u.searchParams.get('lang') === 'en';
      if (en && state === 'en-busy') return busy();
      res.end(JSON.stringify({ type: 'FeatureCollection', features: answer(u.searchParams.get('q') || '', en, u.searchParams.getAll('osm_tag'), english === '-' ? null : decodeURIComponent(english)) }));
      return;
    }
    if (rest === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (rest.includes('interpreter')) {
      if (state === 'busy' || state === 'en-busy') return busy();
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' ')) + decodeURIComponent(u.searchParams.get('data') || '');
        const elements = [];
        for (const m of q.matchAll(/\b(node|way|relation)\((\d+)\)/g)) {
          const tags = OSM_TAGS[`${m[1]}/${m[2]}`];
          if (tags) elements.push({ type: m[1], id: Number(m[2]), center: { lon: CASTLE[0], lat: CASTLE[1] }, tags });
        }
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

/** A uw command. `english`: the castle's English name in the search's answers; `state`: "ok", "busy" (Overpass answers
 *  504) or "en-busy" (the English search and Overpass answer 504); `slow`: the place search counts as slow (its English
 *  pass is skipped); `lookups`: the file the services' state is kept in. */
const uw = (args, { input = null, english = null, state = 'ok', slow = false, lookups = 'lookups.json' } = {}) => new Promise((resolve) => {
  const base = `${mock.url}/${english ? encodeURIComponent(english) : '-'}/${state}`;
  const providers = JSON.parse(NO_WIKIPEDIA.INSTAFY_LOOKUP_PROVIDERS);
  if (slow) providers.providers.photon = { slow_ms: 1 };
  const env = { ...process.env, INSTAFY_LOOKUP_PROVIDERS: JSON.stringify(providers), UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: base,
    UW_OVERPASS: `${base}/api/interpreter`, UW_OSRM: mock.url, UW_VALHALLA: mock.url, UW_NO_CACHE: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, lookups), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_TURN_BUDGET', 'UW_TURN_GAP', 'UW_HANDOFF_STEP', 'UW_PLAN_DRAFT', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 120000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const writeCfg = (site, cfg) => fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
const layerOf = (site, id) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features; } catch { return []; } };
const ok = (r) => { assert.equal(r.code, 0, r.out + r.err); return r; };
const askedErrors = async (site) => { const v = await uw(['validate', site, '--json']); return (v.json?.errors || []).filter((e) => e.path === '$.asked'); };
/** A trip map of Kraków whose message named the castle. */
async function krakowMap(site) {
  ok(await uw(['new', site, '--title', '3 days in Kraków', '--ask', 'What to see', '--center', KRAKOW.join(','), '--zoom', '13', '--expect', 'Kraków:3', '--asked', 'Wawel Castle']));
  ok(await uw(['add-point', site, '--layer', 'stops', '--at', KRAKOW.join(','), '--name', 'Kraków', '--kind', 'city', '--id', 'krakow', '--props', '{"nights":3}']));
}
const sight = (site, query, more = [], opts = {}) => uw(['add-point', site, '--layer', 'sights', '--query', query, '--near', KRAKOW.join(','), ...more, '--props-file', '-'],
  { input: JSON.stringify({ stop: 'krakow', asked: true }), ...opts });

// ---------------------------------------------------------------------------
test('a place the person named, refused by their name and pinned by its local name under the same id, goes by their name: its mark kept, the check passed', async () => {
  const site = 'krakow-refused-first';
  await krakowMap(site);
  // no English name anywhere: the castle is refused by the person's name for it, and listed
  const refused = await sight(site, 'Wawel Castle, Kraków', ['--id', 'wawel']);
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Wawel Castle']);
  // the refusal says to try the local name: pinned, and it is the place the person named
  const local = ok(await sight(site, 'Zamek Królewski na Wawelu, Kraków', ['--id', 'wawel']));
  assert.doesNotMatch(local.err, /not marked as a place the person named/);
  const pin = layerOf(site, 'sights')[0].properties;
  assert.deepEqual([pin.name, pin.looked_up_as, pin.asked], ['Zamek Królewski na Wawelu', 'Wawel Castle', true]);
  assert.equal(cfgOf(site).missing, undefined);
  assert.deepEqual(await askedErrors(site), []);
});

test('a place the person named, pinned by its local name first: the mark is dropped naming the fix, the check names it too, and either fix names the pin so', async () => {
  const site = 'krakow-local-first';
  await krakowMap(site);
  const local = ok(await sight(site, 'Zamek Królewski na Wawelu, Kraków', ['--id', 'wawel']));
  assert.match(local.err, /not marked as a place the person named: they named "Wawel Castle", not "Zamek Królewski na Wawelu"; .*Only if it IS one of them under another name \(its local name\): uw set krakow-local-first sights:wawel --props-file - with \{"looked_up_as":"Wawel Castle","asked":true\}/);
  assert.equal(layerOf(site, 'sights')[0].properties.asked, undefined);
  const [e] = await askedErrors(site);
  assert.equal(e?.message, 'a place the person named is neither on the map nor listed as not found yet: Wawel Castle');
  assert.match(e.fix, /On the map already under another name \(its local name\)\? Name that pin so: uw set krakow-local-first <its layer>:<its id> --props-file - with \{"looked_up_as":"Wawel Castle","asked":true\}$/);
  // the lookup by the person's name that finds the pin: refused as pinned already, and the pin goes by their name
  const again = await uw(['add-point', site, '--layer', 'sights', '--query', 'Zamek Królewski na Wawelu, Kraków', '--name', 'Wawel Castle', '--near', KRAKOW.join(','), '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'krakow', asked: true }) });
  assert.equal(again.code, 2, again.out + again.err);
  assert.deepEqual([again.json.refused, again.json.named_as, again.json.asked], ['already_pinned', 'Wawel Castle', true]);
  assert.deepEqual(layerOf(site, 'sights').map((f) => [f.properties.id, f.properties.looked_up_as, f.properties.asked]), [['wawel', 'Wawel Castle', true]]);
  assert.deepEqual(await askedErrors(site), []);
  // the other fix, on another map: uw set with the person's name keeps the mark
  const other = 'krakow-set';
  await krakowMap(other);
  ok(await sight(other, 'Zamek Królewski na Wawelu, Kraków', ['--id', 'wawel']));
  const set = ok(await uw(['set', other, 'sights:wawel', '--props-file', '-'], { input: JSON.stringify({ looked_up_as: 'Wawel Castle', asked: true }) }));
  assert.doesNotMatch(set.err, /not marked/);
  assert.equal(layerOf(other, 'sights')[0].properties.asked, true);
  assert.deepEqual(await askedErrors(other), []);
});

test('a place the person named, refused by their name with no id and pinned by its local name under another: the fix the line names keeps the mark and takes its "Not found yet" off', async () => {
  const site = 'krakow-two-ids';
  await krakowMap(site);
  assert.equal((await sight(site, 'Wawel Castle, Kraków')).code, 2);
  const local = ok(await sight(site, 'Zamek Królewski na Wawelu, Kraków', ['--id', 'zamek']));
  assert.match(local.err, /Only if it IS one of them under another name \(its local name\): uw set krakow-two-ids sights:zamek --props-file - with \{"looked_up_as":"Wawel Castle","asked":true\}/);
  const set = ok(await uw(['set', site, 'sights:zamek', '--props-file', '-'], { input: JSON.stringify({ looked_up_as: 'Wawel Castle', asked: true }) }));
  assert.match(set.out, /map\.config\.json: removed its "not found yet" entry/);
  assert.equal(cfgOf(site).missing, undefined);
  assert.equal(layerOf(site, 'sights')[0].properties.asked, true);
  const v = await uw(['validate', site, '--json']);
  assert.deepEqual(v.json.errors.filter((e) => e.path === '$.asked' || e.path === '$.missing'), []);
});

test('a sight looked up by its English name while the place search is slow: its English name is read before a refusal; with no name readable it is taken and said; a hotel is not', async () => {
  // the search slow (its English pass skipped) and Overpass busy: the English name is read on the way to a refusal
  const site = 'krakow-slow';
  ok(await uw(['new', site, '--title', 'Kraków', '--center', KRAKOW.join(','), '--zoom', '13'], { lookups: 'slow-1.json' }));
  const pinned = ok(await uw(['add-point', site, '--layer', 'sights', '--query', 'Wawel Castle, Kraków', '--strict-name', '--near', KRAKOW.join(','), '--id', 'wawel', '--json'],
    { english: 'Wawel Royal Castle', state: 'busy', slow: true, lookups: 'slow-1.json' }));
  assert.equal(pinned.json.chosen.name_en, 'Wawel Royal Castle');
  assert.doesNotMatch(pinned.err, /could not be read/);
  // neither the English names nor the other names can be read: the sight that shares the name's word is taken, and said
  const blind = 'krakow-blind';
  ok(await uw(['new', blind, '--title', 'Kraków', '--center', KRAKOW.join(','), '--zoom', '13'], { lookups: 'slow-2.json' }));
  const taken = await uw(['add-point', blind, '--layer', 'sights', '--query', 'Wawel Castle, Kraków', '--strict-name', '--near', KRAKOW.join(','), '--id', 'wawel'],
    { state: 'en-busy', slow: true, lookups: 'slow-2.json' });
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.match(taken.err, /"Zamek Królewski na Wawelu" was taken for "Wawel Castle" by a word of its name: its other names could not be read \(.+\); check it is that place/);
  // a hotel looked up by its name in the same state (the search slow, not yet found down): refused, saying the names
  // could not be read, never "another of its kind"
  const hotel = await uw(['add-point', blind, '--layer', 'hotels', '--query', 'Wawel Palace Hotel, Kraków', '--near', KRAKOW.join(','), '--id', 'wawel-hotel'],
    { state: 'en-busy', slow: true, lookups: 'slow-3.json' });
  assert.equal(hotel.code, 2, hotel.out + hotel.err);
  assert.match(hotel.err, /^REFUSED: no candidate's own name is "Wawel Palace Hotel" by the names the search gave \(their other names could not be read: .+\): "Hotel Wawel Castle View" only shares a word of it as far as those show:$/m);
  assert.doesNotMatch(hotel.err, /another of its kind/);
});

test('a name with a word of its own carries the title, the "Central" and the code it was looked up by; a business named with generic words only is the one of that name', async () => {
  const madrid = ['Madrid', 'España'], london = ['London', 'United Kingdom'];
  // another theatre, opera house, hotel, arena or market of the kind, which only leaves out what told them apart
  assert.equal(holdsName('Teatro Real, Madrid', ['Teatro Español'], madrid, { type: 'amenity=theatre' }), false);
  assert.equal(holdsName('Royal Opera House, London', ['Opera Holland Park'], london, { type: 'amenity=theatre' }), false);
  assert.equal(holdsName('Real Palácio Hotel, Lisbon', ['Palácio do Governador'], ['Lisboa', 'Portugal'], { type: 'tourism=hotel' }), false);
  assert.equal(holdsName('Royal Garden Hotel, London', ['Garden Court Hotel'], london, { type: 'tourism=hotel' }), false);
  assert.equal(holdsName('O2 Arena, London', ['Copper Box Arena'], london, { type: 'leisure=sports_centre' }), false);
  assert.equal(holdsName('AO Arena, Manchester', ['Copper Box Arena'], ['Manchester'], { type: 'amenity=events_venue' }), false);
  assert.equal(holdsName('Mercado Central, Valencia', ['Mercado de Colón'], ['València', 'España'], { type: 'amenity=marketplace' }), false);
  assert.equal(holdsName('Teatro Real, Madrid', ['Teatro Nacional'], madrid, { type: 'amenity=theatre' }), false, 'a title of another kind');
  assert.equal(holdsName('Old Town Hall, Prague', ['New Town Hall'], ['Praha', 'Prague'], { type: 'amenity=townhall' }), false, 'the opposite word');
  assert.equal(holdsName('Hotel Plaza, Sevilla', ['Hotel Plaza de Armas'], ['Sevilla'], { type: 'tourism=hotel', business: true }), false);
  // the place itself, by any of its names: one that leaves the title out, says its own, or adds no word of its own
  assert.equal(holdsName('Teatro Real, Madrid', ['Teatro Real'], madrid, { type: 'amenity=theatre' }), true);
  assert.equal(holdsName('Royal Alcázar of Seville', ['Alcázar of Seville'], ['Sevilla', 'Seville', 'Spain'], { type: 'tourism=attraction' }), true);
  assert.equal(holdsName('Royal Alcázar of Seville', ['Real Alcázar de Sevilla'], ['Sevilla', 'Seville', 'Spain'], { type: 'tourism=attraction' }), true);
  assert.equal(holdsName('Royal Alcázar', ['Real Alcázar de Sevilla'], ['Seville']), true, 'its title in another language, whatever else it says');
  assert.equal(holdsName('Central Market Hall, Budapest', ['Nagy Vásárcsarnok', 'Great Market Hall'], ['Budapest'], { type: 'amenity=marketplace' }), true);
  assert.equal(holdsName('Manchester Arena', ['AO Arena'], ['Manchester'], { type: 'amenity=events_venue' }), true);
  assert.equal(holdsName('Hotel Plaza, Sevilla', ['Hotel Plaza'], ['Sevilla'], { type: 'tourism=hotel', business: true }), true);
  // a generic word's plural is generic too
  assert.equal(holdsName('Vatican Museums, Rome', ['Musei Vaticani'], ['Roma', 'Italia'], { type: 'tourism=museum' }), true);
  // end to end: the theatre and the hotel are refused, and listed as not found yet
  const site = 'madrid';
  ok(await uw(['new', site, '--title', 'Madrid', '--center', MADRID.join(','), '--zoom', '13']));
  const theatre = await uw(['add-point', site, '--layer', 'venues', '--query', 'Teatro Real, Madrid', '--near', MADRID.join(','), '--id', 'teatro-real']);
  assert.equal(theatre.code, 2, theatre.out + theatre.err);
  const hotel = await uw(['add-point', site, '--layer', 'hotels', '--query', 'Hotel Plaza, Sevilla', '--near', SEVILLE.join(','), '--allow-far', '--id', 'plaza']);
  assert.equal(hotel.code, 2, hotel.out + hotel.err);
  assert.match(hotel.err, /^REFUSED: no candidate's own name is "Hotel Plaza": "Hotel Plaza de Armas" only shares a word of it/m);
  assert.deepEqual(layerOf(site, 'venues'), []);
  assert.deepEqual(layerOf(site, 'hotels'), []);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Teatro Real', 'Hotel Plaza']);
});

test('a sight that is a main road is that road by its usual name; a street is still never a venue, nor a sight by a word of its name', async () => {
  const site = 'paris';
  ok(await uw(['new', site, '--title', 'Paris', '--center', PARIS.join(','), '--zoom', '12']));
  const avenue = ok(await uw(['add-point', site, '--layer', 'sights', '--query', 'Champs-Élysées, Paris', '--near', PARIS.join(','), '--id', 'champs', '--json']));
  assert.deepEqual([avenue.json.chosen.name, avenue.json.chosen.type], ['Avenue des Champs-Élysées', 'highway=primary']);
  const venue = await uw(['add-point', site, '--layer', 'venues', '--query', 'Champs-Élysées, Paris', '--near', PARIS.join(','), '--id', 'champs-venue']);
  assert.equal(venue.code, 2, venue.out + venue.err);
  assert.match(venue.err, /found a street named "Avenue des Champs-Élysées"/);
  const other = 'manchester';
  ok(await uw(['new', other, '--title', 'Manchester', '--center', MANCHESTER.join(','), '--zoom', '12']));
  const street = await uw(['add-point', other, '--layer', 'sights', '--query', 'Brentford, Manchester', '--near', MANCHESTER.join(','), '--id', 'brentford']);
  assert.equal(street.code, 2, street.out + street.err);
  assert.match(street.err, /found a street named "Brentford Street" \[highway=residential\]/);
});

test('the day a stop is reached after a short ride counts a place pinned with no page as uw plan counts it', async () => {
  const site = 'two-cities';
  ok(await uw(['new', site, '--title', 'Two cities', '--center', '-5.99,37.38', '--zoom', '8']));
  const dir = path.join(tmp, site);
  fs.writeFileSync(path.join(dir, 'data', 'sights.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-3.58811, 37.176055] }, properties: { id: 'alhambra', name: 'Alhambra', stop: 'granada' } }] }));
  const cfg = cfgOf(site);
  cfg.layers = [...(cfg.layers || []), { id: 'sights', type: 'points', data: 'data/sights.geojson' }];
  cfg.plan = { title: 'Two cities', sights: ['sights'], planned_at: '2026-01-01T00:00:00.000Z', after_ride: [{ day: 'Wed 25 Nov · Granada', stop: 'Granada' }],
    days: [{ title: 'Wed 25 Nov · Granada', items: [{ text: 'Alhambra', ref: { layer: 'sights', id: 'alhambra' }, check: 'on a page of its own' }] }] };
  writeCfg(site, cfg);
  const v = await uw(['validate', site, '--json']);
  const said = [...v.json.errors, ...v.json.warnings].map((m) => m.message);
  assert.ok(!said.some((m) => /has nothing to see yet/.test(m)), said.join('\n'));
});

test('a stop expected by the person\'s word for a city is the station uw station found by the city\'s local name', async () => {
  const site = 'sevilla';
  ok(await uw(['new', site, '--title', 'Seville', '--center', SEVILLE.join(','), '--zoom', '8', '--expect', 'Seville:2']));
  const s = ok(await uw(['station', site, '--city', 'Sevilla', '--country', 'Spain', '--nights', '2', '--json']));
  assert.deepEqual([s.json.feature.station_of, s.json.feature.station_of_en], ['Sevilla', 'Seville']);
  const v = await uw(['validate', site, '--json']);
  assert.ok(!v.json.errors.some((e) => /asked for but not on the map/.test(e.message)), JSON.stringify(v.json.errors));
});
