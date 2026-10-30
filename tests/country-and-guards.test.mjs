// Generic place lookups (resume-japan-big, resume-taiwan-big, 2026-10-16): `--apply` looked "Tokyo" and "Osaka" up
// with no country (Papua New Guinea, Uganda) and skipped both cities; a researched hotel landed on another hotel whose
// name only shared the city ("Kindness Hotel Taitung" → Sheraton Taitung); walk texts showed raw coordinates; a
// place-search 503 lost a sight; the builder gave up on a 3-minute `--apply`. Country-specific switches moved to the
// adapter area registry. Offline: Photon / Overpass / OSRM are a local mock.
// Run: node --test map-pack/tests/country-and-guards.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_WIKIPEDIA, writeRegistryCache } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', f)).href);
const { nameMatches, countryMatches, areaWordsOf } = await lib('lib/cmd-geocode.mjs');
const { hsrServesBoth, countryOfStop, checkHandoff } = await lib('lib/cmd-handoff.mjs');
const { rankStays } = await lib('lib/cmd-stay.mjs');
const { adapterFor, adapterNamedIn, adapterForArea, adapterCredits } = await lib('adapters/lib/areas.mjs');
const { clockAdvice } = await lib('lib/turn-advice.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-country-'));
const cache = path.join(tmp, 'cache');

// ---------------------------------------------------------------------------
// places
const JP_TOKYO = [139.7594, 35.6828], PG_TOKYO = [151.2, -5.3], JP_STATION = [139.7671, 35.6812];
const JP_OSAKA = [135.5022, 34.6937], UG_OSAKA = [32.5, 0.3];
const TAITUNG = [121.1446, 22.7583];
const near = (c, dx, dy = 0) => [Math.round((c[0] + dx / 90000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const feat = (name, coord, { key = 'place', value = 'city', id = 1, country = '日本', countrycode = 'JP', city, state, district } = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: coord },
  properties: { osm_type: 'N', osm_id: id, osm_key: key, osm_value: value, name, country, countrycode, ...(city ? { city } : {}), ...(state ? { state } : {}), ...(district ? { district } : {}) },
});
let retryTownHits = 0;
function photonAnswer(q, lang, tags) {
  const en = lang === 'en';
  const placeTags = tags.includes('place:city');
  const stationTags = tags.includes('railway:station');
  const jp = (name, nameEn, coord, o = {}) => feat(en ? nameEn : name, coord, { country: en ? 'Japan' : '日本', countrycode: 'JP', ...o });
  if (placeTags && q === 'Tokyo') return [feat('Tokyo', PG_TOKYO, { id: 900, country: 'Papua New Guinea', countrycode: 'PG' }), jp('東京都', 'Tokyo', JP_TOKYO, { id: 901 })];
  if (placeTags && q === 'Tokyo, Japan') return [jp('東京都', 'Tokyo', JP_TOKYO, { id: 901 })];
  if (placeTags && q === 'Osaka, Japan') return [jp('大阪市', 'Osaka', JP_OSAKA, { id: 911 })];
  if (stationTags && q === 'Tokyo') return [jp('東京', 'Tokyo', JP_STATION, { key: 'railway', value: 'station', id: 1 })];
  // Osaka has no station in this mock: the stop falls back to the city centre
  if (!tags.length && q === 'Osaka') return [feat('Osaka', UG_OSAKA, { id: 920, country: 'Uganda', countrycode: 'UG' }), jp('大阪市', 'Osaka', JP_OSAKA, { id: 911 })];
  // a researched hotel and sight in Tokyo
  if (!tags.length && /^Hotel Gracery Shinjuku/.test(q)) return [jp('ホテルグレイスリー新宿', 'Hotel Gracery Shinjuku', near(JP_STATION, 300), { key: 'tourism', value: 'hotel', id: 31, city: '新宿区', district: 'Shinjuku' })];
  if (!tags.length && /^Senso-ji/.test(q)) return [jp('浅草寺', 'Sensō-ji', near(JP_STATION, 900, 400), { key: 'amenity', value: 'place_of_worship', id: 32 })];
  // the Taitung case: the only hotel hit shares nothing with the query but the city
  if (/^Kindness Hotel Taitung/.test(q)) return [feat('Sheraton Taitung Hotel', near(TAITUNG, 200), { key: 'tourism', value: 'hotel', id: 41, country: en ? 'Taiwan' : '臺灣', countrycode: 'TW', city: 'Taitung City' })];
  // a researched sight whose only hit is another place
  if (/^Old Harbour Lighthouse/.test(q)) return [feat('Taitung Forest Park', near(TAITUNG, 900), { key: 'leisure', value: 'park', id: 42, country: en ? 'Taiwan' : '臺灣', countrycode: 'TW', city: 'Taitung City' })];
  if (q === 'Retry Town') return [feat('Retry Town', [10, 50], { id: 51, country: 'Germany', countrycode: 'DE' })];
  return [];
}
const LODGING = [
  { type: 'node', id: 601, c: near(JP_STATION, 150), tags: { tourism: 'hotel', name: 'Station Hotel' } },
  { type: 'node', id: 602, c: near(JP_STATION, -250, 100), tags: { tourism: 'hotel', name: 'Marunouchi Inn' } },
  { type: 'node', id: 603, c: near(JP_OSAKA, 200), tags: { tourism: 'hotel', name: 'Osaka Central Hotel' } },
  { type: 'node', id: 604, c: near(JP_STATION, 2500), tags: { tourism: 'hotel', name: 'Ginza Stay' } },
];
let mock;
function startMock() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname + u.search);
    res.setHeader('content-type', 'application/json');
    if (u.pathname.includes('/table/v1/')) {
      const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
      const d = pts.map((p) => Math.hypot((p[0] - pts[0][0]) * 90000, (p[1] - pts[0][1]) * 111000) * 1.2);
      res.end(JSON.stringify({ code: 'Ok', durations: [d.map((m) => m / 1.25)], distances: [d] }));
      return;
    }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      const q = u.searchParams.get('q');
      if (q === 'Retry Town' && retryTownHits++ < 2) { res.statusCode = 503; res.end('{"message":"busy"}'); return; }
      res.end(JSON.stringify({ type: 'FeatureCollection', features: photonAnswer(q, u.searchParams.get('lang') || 'default', u.searchParams.getAll('osm_tag')) }));
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        const m = q.match(/around:(\d+(?:\.\d+)?),(-?[\d.]+),(-?[\d.]+)/);
        const inRange = (c) => !m || Math.hypot((c[0] - Number(m[3])) * 90000, (c[1] - Number(m[2])) * 111000) <= Number(m[1]) * 1.5;
        const elements = /"tourism"~/.test(q) ? LODGING.filter((e) => inRange(e.c)).map((e) => ({ type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags })) : [];
        res.end(JSON.stringify({ elements }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}
const env = (extra = {}) => {
  const e = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: cache, UW_PHOTON: mock.url, UW_OVERPASS: mock.url + '/api/interpreter', UW_OSRM: mock.url, UW_VALHALLA: mock.url,
    UW_NO_CACHE: '1', UW_TURN_BUDGET: '0', ...extra };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  delete e.INSTAFY_TURN_STARTED_AT; delete e.INSTAFY_TURN_DEADLINE;
  if (extra.INSTAFY_TURN_STARTED_AT) Object.assign(e, { INSTAFY_TURN_STARTED_AT: extra.INSTAFY_TURN_STARTED_AT, INSTAFY_TURN_DEADLINE: extra.INSTAFY_TURN_DEADLINE });
  return e;
};
const uw = (args, extra = {}, cwd = tmp) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd, env: env(extra) });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 120000);
  p.on('close', (code) => {
    clearTimeout(t);
    let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} }
    resolve({ code, out, err, json });
  });
});
const readFC = (site, layer) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${layer}.geojson`), 'utf8'));

// Taiwan's lodging registers from the fixtures' cache: a hotel lookup near Taitung asks them, and never downloads here
before(async () => { await writeRegistryCache(cache); mock = await startMock(); });
after(() => { mock?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
test('a place is in the country the caller names: ISO code or name, English or local', () => {
  const jp = { country: '日本', country_en: 'Japan', countrycode: 'JP' };
  const pg = { country: 'Papua New Guinea', countrycode: 'PG' };
  assert.equal(countryMatches(jp, 'Japan'), true);
  assert.equal(countryMatches(jp, 'jp'), true);
  assert.equal(countryMatches(pg, 'Japan'), false);
  assert.equal(countryMatches({ country: '日本' }, 'Japan'), null, 'only a local name and no English one: cannot tell');
});

test('a query word that only names the area is not a name match, whatever the country', () => {
  const sheraton = { name: 'Sheraton Taitung Hotel', city: 'Taitung City', country: 'Taiwan' };
  const area = areaWordsOf([sheraton]);
  assert.equal(nameMatches('Kindness Hotel Taitung', [sheraton.name], area), false);
  assert.equal(nameMatches('Kindness Hotel Taitung', ['Kindness Hotel Taitung Station'], area), true);
  const lisbon = areaWordsOf([{ city: 'Lisboa', country: 'Portugal', city_en: 'Lisbon' }]);
  assert.equal(nameMatches('Hotel Mundial Lisbon', ['Lisbon Marriott'], lisbon), false);
  assert.equal(nameMatches('Hotel Mundial Lisbon', ['Hotel Mundial'], lisbon), true);
});

test('station --country finds Tokyo in Japan, not Papua New Guinea', async () => {
  await uw(['new', 'jp', '--title', 'Japan', '--center', '139.0,36.0', '--zoom', '6']);
  const bare = await uw(['station', 'jp', '--city', 'Tokyo', '--json']);
  // without a country the first place hit (Papua New Guinea) is the centre: no station near it
  assert.notEqual(bare.code, 0, bare.out + bare.err);
  const r = await uw(['station', 'jp', '--city', 'Tokyo', '--country', 'Japan', '--nights', '2', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.feature.name, '東京');
  assert.deepEqual(readFC('jp', 'stations').features[0].geometry.coordinates, JP_STATION);
});

test('add-point --strict-name never puts a researched hotel on another hotel; --country drops hits elsewhere', async () => {
  await uw(['new', 'tt', '--title', 'Taitung', '--center', TAITUNG.join(','), '--zoom', '13']);
  const loose = await uw(['add-point', 'tt', '--layer', 'stays', '--query', 'Kindness Hotel Taitung', '--near', TAITUNG.join(','), '--json']);
  assert.equal(loose.code, 2, 'the city word alone does not make Sheraton a match');
  const osaka = await uw(['add-point', 'jp', '--layer', 'places', '--query', 'Osaka', '--country', 'Japan', '--allow-far', '--json']);
  assert.equal(osaka.code, 0, osaka.out + osaka.err);
  assert.deepEqual(osaka.json.feature?.geometry?.coordinates ?? readFC('jp', 'places').features[0].geometry.coordinates, JP_OSAKA);
  const nowhere = await uw(['add-point', 'jp', '--layer', 'places', '--query', 'Osaka', '--country', 'Portugal', '--allow-far', '--id', 'x', '--json']);
  assert.equal(nowhere.code, 2);
});

// A researched place the lookup cannot pin: one sight was tried four times while the trip's other days stayed bare.
// A sight's --strict-name refusal ends with the trip guide's rule (retry once, then list it as unverified and move on);
// a place to stay (a researched hotel, as `uw handoff` adds them) is not a sight, and a plain lookup's refusal keeps
// inviting another try.
test('add-point --strict-name: a sight\'s refusal ends with the rule to move on to the next sight after one retry', async () => {
  const RULE = 'Retried once? List it as unverified and add the next sight from the city page.';
  const LISTED = /^Listed on the map as "not found yet"/;
  await uw(['new', 'tt2', '--title', 'Taitung', '--center', TAITUNG.join(','), '--zoom', '13']);
  // the rule comes right after the line that says the place is listed as not found yet
  const afterListed = (r) => { const lines = r.err.trim().split('\n'); const i = lines.findIndex((l) => LISTED.test(l)); return i < 0 ? null : lines[i + 1] ?? null; };
  const mismatch = await uw(['add-point', 'tt2', '--layer', 'sights', '--query', 'Old Harbour Lighthouse', '--near', TAITUNG.join(','), '--strict-name']);
  assert.equal(mismatch.code, 2, mismatch.err);
  assert.equal(afterListed(mismatch), RULE, mismatch.err);
  const none = await uw(['add-point', 'tt2', '--layer', 'sights', '--query', 'Nowhere Cathedral', '--near', TAITUNG.join(','), '--strict-name', '--json']);
  assert.equal(none.code, 2, none.err);
  assert.equal(afterListed(none), RULE, none.err);
  assert.equal(none.json?.next, RULE, 'the JSON says it too');
  const hotel = await uw(['add-point', 'tt2', '--layer', 'stays', '--query', 'Kindness Hotel Taitung', '--near', TAITUNG.join(','), '--kind', 'hotel', '--strict-name', '--no-fit', '--json']);
  assert.equal(hotel.code, 2, hotel.err);
  assert.match(hotel.err, /^Listed on the map as "not found yet"/m);
  assert.doesNotMatch(hotel.err, /Retried once|next sight/, 'a place to stay is not a sight');
  assert.equal(hotel.json?.next, undefined);
  const loose = await uw(['add-point', 'tt2', '--layer', 'sights', '--query', 'Old Harbour Lighthouse', '--near', TAITUNG.join(','), '--json']);
  assert.equal(loose.code, 2);
  assert.doesNotMatch(loose.err, /Retried once/);
  assert.equal(loose.json?.next, undefined);
});

test('stay names a coordinate anchor in words, keeps the station picks, and --prefer any drops the B&B penalty', async () => {
  const r = await uw(['stay', 'jp', '--near', near(JP_STATION, 2400).join(','), '--near-label', 'the centre of Tokyo', '--stop', 'tokyo', '--kinds', 'hotel', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  for (const p of r.json.picks) {
    assert.match(p.why, /to the centre of Tokyo/);
    assert.doesNotMatch(p.why, /\d+\.\d{3,},\s*\d+\.\d{3,}/);
    assert.equal(p.stop, 'tokyo');
  }
  const s2 = await uw(['stay', 'jp', '--near', 'stations:tokyo', '--kinds', 'hotel', '--json']);
  assert.equal(s2.code, 0, s2.out + s2.err);
  const stops = readFC('jp', 'stays').features.map((f) => f.properties.near_ref);
  assert.ok(stops.includes('stations:tokyo') && stops.some((x) => /^\d/.test(x)), 'both anchors keep their picks');
  const bnb = { group: 'bnb', walk_min: 3, walk_m: 240, coord: [0, 0] }, hotel = { group: 'hotel', walk_min: 5, walk_m: 400, coord: [1, 1] };
  assert.equal(rankStays([bnb, hotel])[0].group, 'hotel');
  assert.equal(rankStays([bnb, hotel], { prefer: 'any' })[0].group, 'bnb');
});

test('handoff --apply looks every stop up in its country and places a stop without a station at its centre', async () => {
  const dir = path.join(tmp, 'handoff', 'japan');
  fs.mkdirSync(dir, { recursive: true });
  const base = { schema: 'instafy.research@1', kind: 'city', country: 'Japan', facts: [], legs: [], unknowns: [] };
  fs.writeFileSync(path.join(dir, 'tokyo.json'), JSON.stringify({ ...base, item: 'Tokyo', places: [
    { name: 'Hotel Gracery Shinjuku', query: 'Hotel Gracery Shinjuku, Tokyo', kind: 'hotel', why: 'Godzilla head', source_url: 'https://example.org/gracery' },
    { name: 'Senso-ji', query: 'Senso-ji, Tokyo', kind: 'sight', why: 'oldest temple', source_url: 'https://example.org/sensoji' },
  ] }));
  fs.writeFileSync(path.join(dir, 'osaka.json'), JSON.stringify({ ...base, item: 'Osaka', places: [] }));
  await uw(['new', 'trip', '--title', 'Japan by train', '--center', '137.0,35.5', '--zoom', '6']);
  const r = await uw(['handoff', dir, '--site', 'trip', '--apply', '--route', 'Tokyo:2,Osaka:1', '--start', '2027-04-01', '--no-source-check', '--json'], {}, tmp);
  const res = JSON.parse(r.out.slice(r.out.lastIndexOf('\n{') + 1));
  const stations = Object.fromEntries(readFC('trip', 'stations').features.map((f) => [f.properties.id, f]));
  assert.deepEqual(stations.tokyo.geometry.coordinates, JP_STATION, 'Tokyo, Japan');
  assert.deepEqual(stations.osaka.geometry.coordinates, JP_OSAKA, 'Osaka placed at its centre in Japan, not Uganda');
  assert.ok(res.unverified.some((u) => /Osaka: no railway station found; the stop is the city centre/.test(u)), res.unverified.join('\n'));
  assert.ok(readFC('trip', 'stays').features.some((f) => f.properties.stop === 'osaka'), 'stays at the fallback stop');
  assert.ok(readFC('trip', 'stays').features.some((f) => f.properties.researched && f.properties.why === 'Godzilla head'));
  assert.ok(readFC('trip', 'sights').features.some((f) => f.properties.name === '浅草寺'));
  assert.ok(res.facts.some((f) => /^Osaka: 1 night\(s\), 0 researched sight\(s\)$/.test(f)), res.facts.join('\n'));
  assert.ok(res.facts.some((f) => /^Tokyo → Osaka: \d+ km straight line; duration not sourced; high-speed line near both ends: (unknown|no)/.test(f)), res.facts.join('\n'));
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'trip', 'map.config.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.plan?.days) && cfg.plan.days.length >= 3, 'the plan was written');
});

test('handoff --check validates one file and asks for its country', async () => {
  const f = path.join(tmp, 'one.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 'instafy.research@1', item: 'Porto', kind: 'city', places: [{ name: 'X', kind: 'nope' }] }));
  const r = await uw(['handoff', '--check', f]);
  assert.equal(r.code, 0, 'usable, with problems listed');
  assert.match(r.out, /no "country"/);
  assert.match(r.out, /places\[0\]\.kind must be one of/);
  fs.writeFileSync(f, '{ not json');
  assert.equal((await uw(['handoff', '--check', f])).code, 1);
  assert.equal(checkHandoff({ schema: 'instafy.research@1', item: 'Porto', kind: 'city', country: 'Portugal' }).item.country, 'Portugal');
  assert.equal(countryOfStop([{ kind: 'city', item: 'Porto', country: 'Portugal', places: [] }], 'Porto', 'Japan'), 'Portugal');
  assert.equal(countryOfStop([], 'Porto', 'Japan'), 'Japan');
});

test('HSR is suggested only where the loaded track has a high-speed line at both ends', () => {
  const line = (kind, coords) => ({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: coords } });
  const west = line('hsr', [[121.5, 25.0], [120.2, 23.0]]), east = line('rail', [[121.6, 24.0], [121.1, 22.7]]);
  assert.equal(hsrServesBoth({ features: [west, east] }, [121.51, 25.01], [120.21, 23.01]), true);
  assert.equal(hsrServesBoth({ features: [west, east] }, [121.6, 24.0], [121.1, 22.7]), false, 'east coast: no high-speed line');
  assert.equal(hsrServesBoth(null, [0, 0], [1, 1]), null, 'no track loaded: unknown');
});

test('a busy place search that answers 503 is asked again', async () => {
  retryTownHits = 0;
  const r = await uw(['geocode', 'Retry Town', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.candidates[0].name, 'Retry Town');
  assert.equal(retryTownHits, 3, 'two 503s, then the answer');
});

test('long commands run as jobs: --detach returns at once, uw wait prints the output and the exit code', async () => {
  const start = await uw(['geocode', 'Tokyo, Japan', '--detach'], {}, tmp);
  assert.equal(start.code, 0, start.err);
  const id = start.out.match(/started job (\S+):/)[1];
  let w;
  for (let i = 0; i < 20; i++) { w = await uw(['wait', id, '--max', '5'], {}, tmp); if (w.code !== 75) break; }
  assert.equal(w.code, 0, w.out + w.err);
  assert.match(w.out, /東京都|Tokyo/);
  assert.match(w.out, new RegExp(`job ${id} finished: exit 0`));
  const again = await uw(['wait', id], {}, tmp);
  assert.equal(again.code, 0, 'waiting on a finished job repeats its exit code');
  assert.doesNotMatch(again.out, /東京都/, 'output already printed is not printed twice');
});

test('generic commands ask the adapter area registry, never a country test', () => {
  assert.equal(adapterFor('lodging-register', [121.52, 25.05])?.name, 'tw-hotels');
  assert.equal(adapterFor('lodging-register', [139.7, 35.68]), null);
  assert.equal(adapterFor('metro-stations', [121.52, 25.05])?.name, 'tw-metro');
  assert.equal(adapterNamedIn('lodging-register', 'Lore Hotel, Taipei')?.name, 'tw-hotels');
  assert.equal(adapterForArea('lodging-register', { config: { view: { center: [-9.14, 38.71], zoom: 12 } } }, null, ''), null);
  assert.ok(adapterCredits().some((c) => c.marks.propPrefix === 'tw_' && c.re.test('政府資料開放授權條款')));
  const lib = path.join(SKILL, 'scripts', 'lib');
  for (const f of ['cmd-geocode.mjs', 'cmd-stay.mjs', 'cmd-places.mjs', 'validate-v2.mjs']) {
    const src = fs.readFileSync(path.join(lib, f), 'utf8');
    assert.doesNotMatch(src, /inTaiwan\(|areaInTaiwan\(|taiwan\|taipei/i, `${f} tests for a country`);
  }
});

test('validate flags raw coordinates in text people read and day texts without a source that day', async () => {
  await uw(['new', 'lint', '--title', 'Lint', '--center', '10,50', '--zoom', '12']);
  const dataDir = path.join(tmp, 'lint', 'data');
  fs.writeFileSync(path.join(dataDir, 'stays.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 50] }, properties: { id: 'a', name: 'A', why: '4 min walk to 121.60681,23.98207' } }] }));
  const cfgPath = path.join(tmp, 'lint', 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.layers = [...(cfg.layers || []), { id: 'stays', title: 'Stays', type: 'points', data: 'data/stays.geojson' }];
  cfg.plan = { days: [{ title: 'Day 1', text: 'x'.repeat(150), items: [] }] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = await uw(['validate', 'lint', '--json']);
  const text = JSON.stringify(r.json);
  assert.match(text, /shows raw coordinates to the reader/);
  assert.match(text, /day text is 150 characters/);
  assert.match(text, /day text with no sourced item that day/);
});

test('the turn clock follows the host deadline and prints facts', async () => {
  assert.match(clockAdvice(400, null, 480), /about 1m20s left/);
  const started = new Date(Date.now() - 300_000).toISOString(), deadline = new Date(Date.now() + 300_000).toISOString();
  const r = await uw(['validate', 'lint'], { UW_TURN_BUDGET: undefined, INSTAFY_TURN_STARTED_AT: started, INSTAFY_TURN_DEADLINE: deadline });
  // 600 s turn minus the 120 s reply margin: 480 s for tools, 300 used
  assert.match(r.err, /time: 5m0\ds used, about (2m5\d|3m0\d)s left for tool work this turn/, r.err);
});
