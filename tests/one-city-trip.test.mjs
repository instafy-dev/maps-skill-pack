// Days in one city, as a person asks for them: "Plan 3 days in Seville for a first visit: where to stay, what to see
// each day, on a map." (a run on 31 Oct 2026). The turn listed its own items in `uw new --expect` ("Where to stay,
// Day 1: historic center, …"), renamed its pins to match ("Day 1 · Alcazar and cathedral"), and planned those pins as
// the trip's stops: "Travel day … about 10 min by train" between neighbourhoods 2 km apart, four dates for three days,
// a "Days" group in the list, and one neighbourhood pinned as the hotel. Now `--expect` takes only stops with nights,
// `uw plan` refuses stays a short ride apart that are places in one city (sights, neighbourhoods), and a stay in one
// place has no departure date. Two towns a short ride apart (Positano and Amalfi), a night at the airport, and a stop
// the request named beside a town are still a trip. The flow the guide gives (reference/itinerary.md "One base") ends with one stop,
// three dated days of 2-3 sights each, every sight cited from its own page, places to stay from `uw stay`, no travel
// day, and `uw validate` passes.
// Offline: the place search, the lodging search and the walking router are a local mock in this file.
// Run: node --test tests/one-city-trip.test.mjs
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
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { parseStops, expectOf } = await lib('expect.mjs');
const { sameCityStays, buildPlan, routeLine } = await lib('cmd-plan.mjs');
const { haversine } = await lib('util.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-one-city-'));

// ---------------------------------------------------------------------------
// Seville as the place search answers it (names, kinds and positions as OpenStreetMap has them, rounded)
const CITY = [-5.99534, 37.38863];
const SANTA_CRUZ = [-5.9905, 37.3855];
// each sight with its own page (the attraction's article): a city page only says which places are worth it
const SIGHTS = [
  { id: 'catedral', name: 'Catedral de Sevilla', en: 'Seville Cathedral', c: [-5.993141, 37.385915], key: 'amenity', value: 'place_of_worship', page: 'https://en.wikipedia.org/wiki/Seville_Cathedral', why: 'the Giralda tower and Columbus\'s tomb' },
  { id: 'alcazar', name: 'Real Alcázar de Sevilla', en: 'Royal Alcázar of Seville', c: [-5.990183, 37.383211], key: 'historic', value: 'castle', page: 'https://en.wikipedia.org/wiki/Alc%C3%A1zar_of_Seville', why: 'Mudéjar palace and gardens' },
  { id: 'pilatos', name: 'Casa de Pilatos', en: 'Casa de Pilatos', c: [-5.987249, 37.390239], key: 'tourism', value: 'museum', page: 'https://en.wikipedia.org/wiki/Casa_de_Pilatos', why: 'Andalusian palace with tiled patios' },
  { id: 'mercado-triana', name: 'Mercado de Triana', en: 'Triana Market', c: [-6.00355, 37.38575], key: 'amenity', value: 'marketplace', page: 'https://es.wikipedia.org/wiki/Mercado_de_Triana', why: 'food market over the castle ruins' },
  { id: 'santa-ana', name: 'Iglesia de Santa Ana', en: 'Church of Saint Anne', c: [-6.00296, 37.38326], key: 'amenity', value: 'place_of_worship', page: 'https://es.wikipedia.org/wiki/Iglesia_de_Santa_Ana_(Sevilla)', why: 'the oldest parish church in Seville' },
  { id: 'museo-arqueologico', name: 'Museo Arqueológico de Sevilla', en: 'Archaeological Museum of Seville', c: [-5.98614, 37.37296], key: 'tourism', value: 'museum', page: 'https://en.wikipedia.org/wiki/Archaeological_Museum_of_Seville', why: 'the Carambolo treasure' },
  { id: 'maria-luisa', name: 'Parque de María Luisa', en: 'María Luisa Park', c: [-5.988956, 37.378779], key: 'leisure', value: 'park', page: 'https://en.wikipedia.org/wiki/Parque_de_Mar%C3%ADa_Luisa', why: 'shaded gardens by the square' },
];
const off = (c, dx, dy) => [Math.round((c[0] + dx / 88400) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const LODGING = [
  { type: 'node', id: 801, c: off(SANTA_CRUZ, 150, 0), tags: { tourism: 'hotel', name: 'Hotel Patio de la Cruz', stars: '3' } },
  { type: 'way', id: 802, c: off(SANTA_CRUZ, 0, 300), tags: { tourism: 'hotel', name: 'Hotel Judería' } },
  { type: 'node', id: 803, c: off(SANTA_CRUZ, 350, -350), tags: { tourism: 'hotel', name: 'Hotel Murallas', rooms: '40' } },
  { type: 'node', id: 804, c: off(SANTA_CRUZ, -100, 0), tags: { tourism: 'hostel', name: 'Albergue Santa Cruz' } },
];
// the address in the language asked for (lang=en: the English names)
const SEVILLA = { district: 'Casco Antiguo', city: 'Sevilla', state: 'Andalucía', country: 'España', countrycode: 'ES' };
const SEVILLE = { district: 'Casco Antiguo', city: 'Seville', state: 'Andalusia', country: 'Spain', countrycode: 'ES' };
const photon = (en, name, c, key, value, id, extra = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c },
  properties: { osm_type: 'N', osm_id: id, osm_key: key, osm_value: value, name, ...(en ? SEVILLE : SEVILLA), ...extra } });
function photonAnswer(q, en) {
  if (/^Sevilla$|^Seville(, Spain)?$/.test(q)) return [photon(en, en ? 'Seville' : 'Sevilla', CITY, 'place', 'city', 342563, { osm_type: 'R', district: undefined, city: undefined })];
  if (q === 'Santa Cruz, Seville') return [photon(en, 'Santa Cruz', SANTA_CRUZ, 'place', 'neighbourhood', 4649140, { osm_type: 'R' })];
  const s = SIGHTS.find((x) => x.name === q);
  return s ? [photon(en, en ? s.en : s.name, s.c, s.key, s.value, 7100 + SIGHTS.indexOf(s), s.id === 'mercado-triana' || s.id === 'santa-ana' ? { district: 'Triana' } : {})] : [];
}

let mock;
before(async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    res.setHeader('content-type', 'application/json');
    if (u.pathname.includes('/table/v1/')) {
      const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
      const d = pts.map((p) => haversine(pts[0], p) * 1.2);
      res.end(JSON.stringify({ code: 'Ok', durations: [d.map((m) => m / 1.25)], distances: [d] }));
      return;
    }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      // a type search (osm_tag filters) finds nothing more: the name search is the one that answers
      const feats = u.searchParams.getAll('osm_tag').length ? [] : photonAnswer(u.searchParams.get('q') || '', u.searchParams.get('lang') === 'en');
      res.end(JSON.stringify({ type: 'FeatureCollection', features: feats.map((f) => ({ ...f, properties: Object.fromEntries(Object.entries(f.properties).filter(([, v]) => v !== undefined)) })) }));
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        const elements = /"tourism"~/.test(q) ? LODGING.filter(near).map((e) => (e.type === 'node' ? { type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags }
          : { type: e.type, id: e.id, center: { lon: e.c[0], lat: e.c[1] }, tags: e.tags })) : [];
        res.end(JSON.stringify({ elements }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mock = { server, hits, url: `http://127.0.0.1:${server.address().port}` };
});
after(() => { mock?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const uw = (args, { input = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE']) delete env[k];
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features;

// ---------------------------------------------------------------------------
test('--expect takes only a trip\'s stops with their nights; anything else is refused, and the map does not read it', () => {
  assert.deepEqual(parseStops('Seville:3'), [{ name: 'Seville', nights: 3 }]);
  assert.deepEqual(parseStops('Porto: 3, Lisbon:4'), [{ name: 'Porto', nights: 3 }, { name: 'Lisbon', nights: 4 }]);
  assert.deepEqual(parseStops(''), []);
  assert.throws(() => parseStops('Where to stay,Day 1: historic center,Seville:3'),
    /^UsageError: --expect: "Where to stay", "Day 1: historic center" are not stops with nights\. Name only the trip's stops with their nights \("Lisbon:3"\)\. Days and stays come from uw plan and uw stay\.$/);
  // a map an older pack made with its own items there: only its stops are read
  assert.deepEqual(expectOf({ expect: [{ name: 'Where to stay' }, { name: 'Day 1: historic center' }, { name: 'Seville', nights: 3 }] }), [{ name: 'Seville', nights: 3 }]);
});

test('uw plan refuses stays a short ride apart in one city (sights, neighbourhoods, two stations of one city); two towns, a station, an airport, and a stop the request named beside a town are a trip', () => {
  const at = (id, c, props = {}) => ({ id, coord: c, props: { id, name: id, ...props } });
  // the run's three day pins, 1 to 2 km apart, a night each (their kinds as the place search gave them)
  const pins = [at('day1', [-5.990183, 37.383211], { name: 'Day 1 · Alcazar and cathedral', kind: 'castle' }),
    at('day2', [-6.004067, 37.383452], { name: 'Day 2 · Triana', kind: 'suburb' }), at('day3', [-5.98565, 37.376903], { name: 'Day 3 · Plaza de España', kind: 'artwork' })];
  const near = sameCityStays(pins, [1, 1, 1]);
  assert.equal(near.a.id, 'day1');
  assert.equal(near.b.id, 'day2');
  assert.ok(near.km > 1 && near.km < 1.5, String(near.km));
  assert.equal(near.nights, 3);
  assert.equal(near.others, false);
  // the map's one stop ("Seville:3") names none of them as a stop of its own; and pins that are neither a town nor a
  // station stay one city even when "expect" lists each of them with a night
  assert.ok(sameCityStays(pins, [1, 1, 1], { expect: [{ name: 'Seville', nights: 3 }] }));
  assert.ok(sameCityStays(pins, [1, 1, 1], { expect: pins.map((p) => ({ name: p.props.name, nights: 1 })) }));
  const east = (km) => [Math.round((-5.99 + km / 88.4) * 1e6) / 1e6, 37.38];
  // a pin with no kind (an address, a point placed by hand) is a place in a town too
  assert.ok(sameCityStays([at('a', east(0)), at('b', east(14))], [2, 2]), '14 km: one city');
  assert.equal(sameCityStays([at('a', east(0)), at('b', east(16))], [2, 2]), null, '16 km: a trip out of town');
  // places of their own a short ride apart: two towns on one coast, a city and a city-state, a station and a village,
  // a night at the airport before the city
  const place = (id, name, c, kind, more = {}) => at(id, c, { name, kind, ...more });
  assert.equal(sameCityStays([place('positano', 'Positano', [14.4842, 40.6281], 'town'), place('amalfi', 'Amalfi', [14.6027, 40.634], 'town')], [2, 2]), null, '10 km');
  assert.equal(sameCityStays([place('nice', 'Nice', [7.262, 43.7031], 'city'), place('monaco', 'Monaco', [7.4246, 43.7384], 'country')], [3, 2]), null, '13 km');
  assert.equal(sameCityStays([place('interlaken', 'Interlaken Ost', [7.8632, 46.6863], 'train_station', { station_of: 'Interlaken' }),
    place('lauterbrunnen', 'Lauterbrunnen', [7.9091, 46.5935], 'village')], [2, 2]), null, '11 km');
  assert.equal(sameCityStays([place('nce', 'Nice Côte d\'Azur Airport', [7.2153, 43.6584], 'aerodrome'), place('nice', 'Nice', [7.262, 43.7031], 'city')], [1, 3]), null, '6 km');
  // two stations of one city are one city
  assert.ok(sameCityStays([place('sj', 'Sevilla-Santa Justa', east(0), 'train_station', { station_of: 'Seville' }),
    place('sb', 'Sevilla-San Bernardo', east(1.5), 'train_station', { station_of: 'Seville' })], [2, 1]));
  // a town and a stop beside it that is not a place of its own (a hut): a trip when the map's "expect" names both, as
  // uw validate then asks for both in the plan; one entry for the town alone keeps them one place
  const hut = [place('zermatt', 'Zermatt', [7.7491, 46.0207], 'village'), place('hornli', 'Hörnli Hut', [7.6844, 45.9822], 'alpine_hut')];
  assert.ok(sameCityStays(hut, [2, 1]));
  assert.ok(sameCityStays(hut, [2, 1], { expect: [{ name: 'Zermatt', nights: 3 }] }));
  assert.equal(sameCityStays(hut, [2, 1], { expect: [{ name: 'Zermatt', nights: 2 }, { name: 'Hörnli Hut', nights: 1 }] }), null);
  // a stop passed through (an airport, a high-speed station out of town) is not a stay
  assert.equal(sameCityStays([at('airport', east(0)), at('city', east(9))], [0, 3]), null);
  assert.equal(sameCityStays([at('city', east(0)), at('city-hsr', east(11)), at('far', east(300))], [2, 0, 2]), null);
  // a loop names its first stop again
  assert.equal(sameCityStays([at('a', east(0)), at('b', east(300)), at('a', east(0))], [2, 2, 1]), null);
  // the nights to plan as one stop are the close stays' own, and the trip's other stops stay
  const trip = sameCityStays([pins[0], pins[1], place('cordoba', 'Córdoba', [-4.7794, 37.8882], 'city')], [2, 1, 2]);
  assert.equal(trip.nights, 3);
  assert.equal(trip.others, true);
  // an airport passed through on arrival is a stop of the trip too
  assert.equal(sameCityStays([at('airport', east(-9)), pins[0], pins[1]], [0, 2, 1]).others, true);
});

test('a stay in one place has no departure date; a trip of several stops keeps its own; the stay line runs to the day they leave', () => {
  const seville = { id: 'seville', layer: 'stops', coord: CITY, props: { id: 'seville', name: 'Seville', kind: 'city' } };
  const one = buildPlan({ stops: [seville], nights: [3], start: '2026-11-01' });
  assert.deepEqual(one.days.map((d) => d.title), ['Sun 1 Nov · Seville', 'Mon 2 Nov · Seville', 'Tue 3 Nov · Seville']);
  assert.ok(!one.days.some((d) => d.depart));
  assert.equal(routeLine([seville], [3], one, '2026-11-01'), 'Seville 3 (3 nights, Sun 1 Nov – Wed 4 Nov)');
  const cordoba = { id: 'cordoba', layer: 'stops', coord: [-4.7794, 37.8882], props: { id: 'cordoba', name: 'Córdoba', kind: 'city' } };
  const two = buildPlan({ stops: [seville, cordoba], nights: [2, 1], start: '2026-11-01' });
  assert.deepEqual(two.days.map((d) => d.title), ['Sun 1 Nov · Seville', 'Mon 2 Nov · Seville', 'Tue 3 Nov · Seville → Córdoba', 'Wed 4 Nov · Córdoba: depart']);
  assert.equal(routeLine([seville, cordoba], [2, 1], two, '2026-11-01'), 'Seville 2 → Córdoba 1 (3 nights, Sun 1 Nov – Wed 4 Nov)');
});

test('case 1 ("3 days in Seville … where to stay, what to see each day"): one stop, three dated days of 2-3 sights from their own pages, stays from uw stay, no travel day and no "Days" group; validate passes', async () => {
  // the run's own list of days and stays: refused, and nothing is made
  const listed = await uw(['new', 'sv-listed', '--title', '3 days in Seville', '--center', CITY.join(','), '--zoom', '13',
    '--expect', 'Where to stay,Day 1: historic center,Day 2: Triana,Day 3: Plaza de España and parks']);
  assert.equal(listed.code, 2, listed.out + listed.err);
  assert.match(listed.err, /--expect: "Where to stay", "Day 1: historic center", "Day 2: Triana", "Day 3: Plaza de España and parks" are not stops with nights\. Name only the trip's stops with their nights \("Lisbon:3"\)\. Days and stays come from uw plan and uw stay\./);
  assert.equal(fs.existsSync(path.join(tmp, 'sv-listed')), false, 'nothing made');

  // reference/itinerary.md "One base": the site with its one stop and nights, the city as the stop
  const made = await uw(['new', 'sv', '--title', '3 days in Seville', '--ask', 'Where to stay and what to see each day', '--center', CITY.join(','), '--zoom', '13', '--expect', 'Seville:3']);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /Then: a trip \(Seville \(3 nights\)\): follow reference\/itinerary\.md \("One base" for days in one place\)/);
  assert.deepEqual(cfgOf('sv').expect, [{ name: 'Seville', nights: 3 }]);
  const stop = await uw(['add-point', 'sv', '--layer', 'stops', '--query', 'Seville', '--country', 'Spain', '--kind', 'city', '--id', 'seville', '--name', 'Seville', '--props', '{"nights":3}', '--json']);
  assert.equal(stop.code, 0, stop.out + stop.err);
  // stays in the area to stay in, from the lodging search: hotels, each with its walk
  const area = await uw(['geocode', 'Santa Cruz, Seville', '--json']);
  assert.equal(area.code, 0, area.err);
  const stays = await uw(['stay', 'sv', '--near', area.json.candidates[0].coord.join(','), '--near-label', 'Santa Cruz', '--stop', 'seville', '--kinds', 'hotel', '--json']);
  assert.equal(stays.code, 0, stays.out + stays.err);
  assert.deepEqual(stays.json.picks.map((p) => p.name), ['Hotel Patio de la Cruz', 'Hotel Judería', 'Hotel Murallas']);
  // each sight read from its own page, pinned in a command of its own
  for (const s of SIGHTS) {
    const r = await uw(['add-point', 'sv', '--layer', 'sights', '--query', s.name, '--country', 'Spain', '--strict-name', '--near', area.json.candidates[0].coord.join(','), '--id', s.id, '--props-file', '-', '--json'],
      { input: JSON.stringify({ stop: 'seville', source_url: s.page, source: 'Wikipedia', why: s.why }) });
    assert.equal(r.code, 0, `${s.name}: ${r.out}${r.err}`);
  }

  // the run's plan, its pins as stops a night each: refused, and nothing is written
  const pins = await uw(['plan', 'sv', '--stops', 'sights', '--ids', 'alcazar,mercado-triana,museo-arqueologico', '--nights', '1,1,1', '--start', '2026-11-01', '--sights', 'sights']);
  assert.equal(pins.code, 1, pins.out + pins.err);
  assert.match(pins.err, /These are places in one city \(Royal Alcázar of Seville and Triana Market are 1\.2 km apart\)\. Plan one stop \(--ids <city> --nights 3: the city, as reference\/itinerary\.md "One base" pins it\); its sights are grouped into days by area\./);
  assert.equal(cfgOf('sv').plan, undefined);

  const r = await uw(['plan', 'sv', '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-01', '--stays', 'stays', '--sights', 'sights', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.route, 'Seville 3 (3 nights, Sun 1 Nov – Wed 4 Nov)');
  const cfg = cfgOf('sv');
  const days = cfg.plan.days;
  // three dated days, no travel day, no departure date
  assert.deepEqual(days.map((d) => d.title), ['Sun 1 Nov · Seville', 'Mon 2 Nov · Seville', 'Tue 3 Nov · Seville']);
  assert.ok(days.every((d) => !d.depart && !d.title.includes('→') && !/^(Travel day|Leave )/.test(d.text) && !d.items.some((it) => /🚆|by train/.test(it.text))), JSON.stringify(days, null, 1));
  // each day: a loop from the rank-1 stay (named on the arrival day), and 2 or 3 sights cited from their own pages
  assert.match(days[0].items[0].text, /^Base: Hotel Patio de la Cruz · \d+ min walk to Santa Cruz$/);
  const byId = Object.fromEntries(SIGHTS.map((s) => [s.id, s]));
  for (const d of days) {
    assert.deepEqual(d.focus, { layer: 'stays', id: stays.json.picks[0].id });
    const sights = d.items.filter((it) => it.ref?.layer === 'sights');
    assert.ok(sights.length >= 2 && sights.length <= 3, `${d.title}: ${sights.map((it) => it.text).join(', ')}`);
    for (const it of sights) assert.equal(it.url, byId[it.ref.id].page, `${it.text} links its own page`);
    assert.doesNotMatch(d.text, /^(Day in|Arrive in Seville; night 1 of 3\.$)/, `${d.title} says what it is for: ${d.text}`);
  }
  assert.equal(new Set(days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.url))).size, SIGHTS.length, 'every sight on a day, each with a page of its own');
  // places to stay are hotels the lodging search found, never the area pinned as one
  const stayFeats = layerOf('sv', 'stays');
  assert.deepEqual(stayFeats.map((f) => f.properties.kind), ['hotel', 'hotel', 'hotel']);
  assert.ok(stayFeats.every((f) => f.properties.stop === 'seville' && /min walk to Santa Cruz/.test(f.properties.why)), JSON.stringify(stayFeats.map((f) => f.properties.why)));
  // the groups this flow makes: the stop, the stays and the sights. Nothing in the pack refuses a layer of days; the
  // flow has no step that makes one, and its plan is the map's Plan tab
  const titles = cfg.layers.map((l) => l.title);
  assert.ok(!cfg.layers.some((l) => /^days?$/i.test(l.id) || /^days?$/i.test(l.title || '')), JSON.stringify(titles));
  assert.ok(![...layerOf('sv', 'sights'), ...stayFeats].some((f) => /^Day \d/.test(f.properties.name)), 'no pin named after a day');
  // nothing went off this machine but to the mock, and the map checks out
  assert.equal((await uw(['fit', 'sv'])).code, 0);
  const v = await uw(['validate', 'sv', '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.deepEqual(v.json.errors, []);
  assert.ok(!v.json.warnings.some((w) => /day places|cite one page|nothing to see|still empty|fewer than 2/.test(w.message)), JSON.stringify(v.json.warnings, null, 1));
});

test('two towns a short ride apart are a trip: planned with a travel day, and validate passes; a city\'s pins beside another city are one stop of their own nights', async () => {
  // "2 nights in Positano, then 2 in Amalfi": two towns 10 km apart on one coast, each pinned as the town it is
  const made = await uw(['new', 'coast', '--title', 'The Amalfi coast', '--center', '14.54,40.63', '--zoom', '11', '--expect', 'Positano:2,Amalfi:2']);
  assert.equal(made.code, 0, made.err);
  for (const [id, name, c] of [['positano', 'Positano', '14.4842,40.6281'], ['amalfi', 'Amalfi', '14.6027,40.634']]) {
    const r = await uw(['add-point', 'coast', '--layer', 'stops', '--at', c, '--name', name, '--id', id, '--kind', 'town', '--props', '{"nights":2}']);
    assert.equal(r.code, 0, r.out + r.err);
  }
  const plan = await uw(['plan', 'coast', '--stops', 'stops', '--ids', 'positano,amalfi', '--nights', '2,2', '--start', '2026-11-01', '--json']);
  assert.equal(plan.code, 0, plan.out + plan.err);
  assert.equal(plan.json.route, 'Positano 2 → Amalfi 2 (4 nights, Sun 1 Nov – Thu 5 Nov)');
  assert.equal(plan.json.plan.days[2].title, 'Tue 3 Nov · Positano → Amalfi');
  const v = await uw(['validate', 'coast', '--json']);
  assert.deepEqual(v.json.errors.filter((e) => /^\$\.(expect|plan)/.test(e.path)), [], JSON.stringify(v.json.errors, null, 1));

  // a night at a hut above a village: a trip when the request named both stops, and validate passes
  assert.equal((await uw(['new', 'alps', '--title', 'Zermatt and the Hörnli Hut', '--center', '7.72,46.0', '--zoom', '11', '--expect', 'Zermatt:2,Hörnli Hut:1'])).code, 0);
  for (const [id, name, c, kind, n] of [['zermatt', 'Zermatt', '7.7491,46.0207', 'village', 2], ['hornli', 'Hörnli Hut', '7.6844,45.9822', 'alpine_hut', 1]]) {
    assert.equal((await uw(['add-point', 'alps', '--layer', 'stops', '--at', c, '--name', name, '--id', id, '--kind', kind, '--props', JSON.stringify({ nights: n })])).code, 0);
  }
  const plan2 = await uw(['plan', 'alps', '--stops', 'stops', '--ids', 'zermatt,hornli', '--nights', '2,1', '--start', '2026-11-01', '--json']);
  assert.equal(plan2.code, 0, plan2.out + plan2.err);
  assert.equal(plan2.json.route, 'Zermatt 2 → Hörnli Hut 1 (3 nights, Sun 1 Nov – Wed 4 Nov)');
  const v2 = await uw(['validate', 'alps', '--json']);
  assert.deepEqual(v2.json.errors.filter((e) => /^\$\.(expect|plan)/.test(e.path)), [], JSON.stringify(v2.json.errors, null, 1));
  // and with no "expect" at all, two towns are still two places
  assert.equal((await uw(['new', 'coast3', '--title', 'The Amalfi coast', '--center', '14.54,40.63', '--zoom', '11'])).code, 0);
  for (const [id, name, c] of [['positano', 'Positano', '14.4842,40.6281'], ['amalfi', 'Amalfi', '14.6027,40.634']]) {
    assert.equal((await uw(['add-point', 'coast3', '--layer', 'stops', '--at', c, '--name', name, '--id', id, '--kind', 'village', '--props', '{"nights":2}'])).code, 0);
  }
  const plan3 = await uw(['plan', 'coast3', '--stops', 'stops', '--ids', 'positano,amalfi', '--nights', '2,2', '--start', '2026-11-01']);
  assert.equal(plan3.code, 0, plan3.out + plan3.err);

  // Seville's pins as stops, then Córdoba: those pins are one stop of their own 3 nights, and Córdoba stays
  assert.equal((await uw(['new', 'andalusia', '--title', 'Seville and Córdoba', '--center', '-5.4,37.6', '--zoom', '8', '--expect', 'Seville:3,Córdoba:2'])).code, 0);
  for (const [id, name, c, kind, n] of [['day1', 'Day 1 · Alcazar and cathedral', '-5.990183,37.383211', 'castle', 2], ['day2', 'Day 2 · Triana', '-6.004067,37.383452', 'suburb', 1],
    ['cordoba', 'Córdoba', '-4.7794,37.8882', 'city', 2]]) {
    assert.equal((await uw(['add-point', 'andalusia', '--layer', 'stops', '--at', c, '--name', name, '--id', id, '--kind', kind, '--props', JSON.stringify({ nights: n })])).code, 0);
  }
  const pins = await uw(['plan', 'andalusia', '--stops', 'stops', '--ids', 'day1,day2,cordoba', '--nights', '2,1,2', '--start', '2026-11-01']);
  assert.equal(pins.code, 1, pins.out + pins.err);
  assert.match(pins.err, /These are places in one city \(Day 1 · Alcazar and cathedral and Day 2 · Triana are 1\.2 km apart\)\. Plan one stop for them \(--ids <city> --nights 3: the city, as reference\/itinerary\.md "One base" pins it\), with the trip's other stops as they are; its sights are grouped into days by area\./);
  assert.equal(cfgOf('andalusia').plan, undefined);
});
