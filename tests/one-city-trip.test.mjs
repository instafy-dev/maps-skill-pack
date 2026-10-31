// Days in one city, as a person asks for them: "Plan 3 days in Seville for a first visit: where to stay, what to see
// each day, on a map." (the 31 Oct 2026 drive). The turn listed its own items in `uw new --expect` ("Where to stay,
// Day 1: historic center, …"), renamed its pins to match ("Day 1 · Alcazar and cathedral"), and planned those pins as
// the trip's stops: "Travel day … about 10 min by train" between neighbourhoods 2 km apart, four dates for three days,
// a "Days" group in the list, and one neighbourhood pinned as the hotel. Now `--expect` takes only stops with nights,
// `uw plan` refuses stays a short ride apart, and a stay in one place has no departure date. The flow the guide gives
// (reference/itinerary.md "One base") ends with one stop, three dated days of 2-3 sights each, every sight cited from
// its own page, places to stay from `uw stay`, no travel day and no "Days" group, and `uw validate` passes.
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

test('uw plan refuses stays a short ride apart (one city), never a stop passed through or a trip between cities', () => {
  const at = (id, c) => ({ id, coord: c, props: { id, name: id } });
  // the drive's three day pins, 1 to 2 km apart, a night each
  const pins = [at('day1', [-5.990183, 37.383211]), at('day2', [-6.004067, 37.383452]), at('day3', [-5.98565, 37.376903])];
  const near = sameCityStays(pins, [1, 1, 1]);
  assert.equal(near.a.id, 'day1');
  assert.equal(near.b.id, 'day2');
  assert.ok(near.km > 1 && near.km < 1.5, String(near.km));
  const east = (km) => [Math.round((-5.99 + km / 88.4) * 1e6) / 1e6, 37.38];
  assert.ok(sameCityStays([at('a', east(0)), at('b', east(14))], [2, 2]), '14 km: one city');
  assert.equal(sameCityStays([at('a', east(0)), at('b', east(16))], [2, 2]), null, '16 km: a trip out of town');
  // a stop passed through (an airport, a high-speed station out of town) is not a stay
  assert.equal(sameCityStays([at('airport', east(0)), at('city', east(9))], [0, 3]), null);
  assert.equal(sameCityStays([at('city', east(0)), at('city-hsr', east(11)), at('far', east(300))], [2, 0, 2]), null);
  // a loop names its first stop again
  assert.equal(sameCityStays([at('a', east(0)), at('b', east(300)), at('a', east(0))], [2, 2, 1]), null);
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
  // the drive's own list of days and stays: refused, and nothing is made
  const drive = await uw(['new', 'sv-drive', '--title', '3 days in Seville', '--center', CITY.join(','), '--zoom', '13',
    '--expect', 'Where to stay,Day 1: historic center,Day 2: Triana,Day 3: Plaza de España and parks']);
  assert.equal(drive.code, 2, drive.out + drive.err);
  assert.match(drive.err, /--expect: "Where to stay", "Day 1: historic center", "Day 2: Triana", "Day 3: Plaza de España and parks" are not stops with nights\. Name only the trip's stops with their nights \("Lisbon:3"\)\. Days and stays come from uw plan and uw stay\./);
  assert.equal(fs.existsSync(path.join(tmp, 'sv-drive')), false, 'nothing made');

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

  // the drive's plan, its pins as stops a night each: refused, and nothing is written
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
  // the list's groups: the stop, the stays and the sights; no "Days"
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
