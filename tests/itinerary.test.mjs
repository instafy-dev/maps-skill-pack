// Multi-city trips (reference/itinerary.md): `uw new --ask`, `uw station` (the main station of a city, OSM stations
// only), `uw stay` (lodging ranked by walking time to that station, with a reason each), `uw legs --follow` (legs on
// the real track instead of straight lines over the mountains, timetable links), `uw plan` (the dated day-by-day plan
// from stops + nights) and the validator's check of plan item links.
// Offline: Photon / Overpass / OSRM are a local mock in this file; the Taiwan register is a fixture cache.
// Run: node --test map-pack/tests/itinerary.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeRegistryCache, NO_WIKIPEDIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { rankStations, rankStays } = await lib('cmd-stay.mjs');
const { buildGraph, trackPath } = await lib('rail-graph.mjs');
const { buildPlan } = await lib('cmd-plan.mjs');
const { haversine } = await lib('util.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-itin-'));
const cache = path.join(tmp, 'cache');

// ---------------------------------------------------------------------------
// mock services
const S = [121.5207, 25.0576]; // the test "station" (Taipei, Shuanglian)
const east = (m) => [Math.round((S[0] + m / 100800) * 1e6) / 1e6, S[1]];
const H = { hualien: [121.600952, 23.99264], port: [121.635772, 23.994212], weather: [121.613497, 23.975096], centre: [121.619728, 23.991342] };
const T = { tra: [120.213043, 22.997215], hsr: [120.286415, 22.924673], centre: [120.184982, 22.991235], hsrBus: [120.2857896, 22.9238544] };
const pt = (name, c, { key = 'railway', value = 'station', id = 1, type = 'N', city = '' } = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c },
  properties: { osm_type: type, osm_id: id, osm_key: key, osm_value: value, name, city, country: '臺灣' } });
function photonAnswer(q, lang, tags) {
  const en = lang === 'en';
  const stationTags = tags.includes('railway:station');
  const placeTags = tags.includes('place:city');
  const lodging = tags.includes('tourism:hotel');
  if (q === 'Hualien' && placeTags) return [pt('花蓮縣', H.centre, { key: 'place', value: 'county', id: 900, type: 'R' })];
  if (q === 'Hualien' && stationTags) return [pt(en ? 'Hualien Port' : '花蓮港', H.port, { id: 2 }), pt(en ? 'Hualien' : '花蓮', H.hualien, { id: 1 })];
  // a name search with no filter finds the weather station first (what add-point saw in the Instafy run)
  if (q === 'Hualien Station' && !tags.length) return [pt('花蓮氣象站', H.weather, { key: 'office', value: 'government', id: 3, type: 'W' })];
  if (q === 'Tainan' && placeTags) return [pt('臺南市', T.centre, { key: 'place', value: 'city', id: 901, type: 'R' })];
  if (q === 'Tainan' && stationTags) return [pt(en ? 'Tainan' : '臺南', T.tra, { id: 10 }), pt(en ? 'Tainan' : '台南', T.hsr, { id: 11 })];
  if (q === '高鐵台南' && !tags.length) return [pt('高鐵台南站', T.hsrBus, { key: 'highway', value: 'bus_stop', id: 12 })];
  if (lodging && q === '阿爾法飯店' && en) return [pt('Alpha Hotel', east(150), { key: 'tourism', value: 'hotel', id: 77 })];
  return [];
}
const AMS = [4.9005, 52.3789];
const LX = [-9.1372, 38.7101];
const lx = (dx, dy) => [Math.round((LX[0] + dx / 87000) * 1e6) / 1e6, Math.round((LX[1] + dy / 111000) * 1e6) / 1e6];
const ams = (dx, dy) => [Math.round((AMS[0] + dx / 68000) * 1e6) / 1e6, Math.round((AMS[1] + dy / 111000) * 1e6) / 1e6];
const OSM_LODGING = [
  { type: 'node', id: 501, c: ams(200, 0), tags: { tourism: 'hotel', name: 'Hotel Nord', stars: '4' } },
  { type: 'way', id: 502, c: ams(0, -450), tags: { tourism: 'hotel', name: 'Canal Rooms', website: 'https://example.org/canal' } },
  { type: 'node', id: 503, c: ams(-120, 60), tags: { tourism: 'guest_house', name: 'Little Guest House', rooms: '3' } },
  { type: 'node', id: 504, c: ams(300, 300), tags: { tourism: 'hostel', name: 'Harbour Hostel' } },
  { type: 'node', id: 505, c: ams(50, 50), tags: { tourism: 'hotel' } }, // no name: never a pick
  // Baixa, Lisbon (the 29 Oct 2026 drive): the three closest are hostels, the first hotel is 450 m away; across the
  // river, hostels only within 800 m
  ...[[601, 40, 0, 'Lounge Hostel'], [602, -30, 50, 'Downtown Rooms Hostel'], [603, 0, -70, 'Draft Hostel']].map(([id, dx, dy, name]) => ({ type: 'node', id, c: lx(dx, dy), tags: { tourism: 'hostel', name } })),
  { type: 'way', id: 604, c: lx(450, 0), tags: { tourism: 'hotel', name: 'Hotel Rua Augusta', stars: '4' } },
  { type: 'node', id: 605, c: lx(3000, -3000), tags: { tourism: 'hostel', name: 'River Hostel' } },
  // by the Taiwan test station: what OpenStreetMap lists when the lodging register cannot answer
  { type: 'node', id: 701, c: east(220), tags: { tourism: 'hotel', name: 'Shuanglian Inn' } },
];
let mock;
function startMock() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname + u.search);
    res.setHeader('content-type', 'application/json');
    if (u.pathname.startsWith('/busy/')) { req.on('data', () => {}); req.on('end', () => { res.statusCode = 504; res.end('<html>504</html>'); }); return; }
    // a service that never answers (the client gives up)
    if (u.pathname.startsWith('/hang/')) { req.on('data', () => {}); return; }
    if (u.pathname.startsWith('/osrm404/')) { res.statusCode = 404; res.end('{"code":"NoRoute"}'); return; }
    if (u.pathname.includes('/table/v1/')) {
      const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
      // 1.25 m/s on foot, streets 1.2 × the straight line
      const d = pts.map((p) => haversine(pts[0], p) * 1.2);
      res.end(JSON.stringify({ code: 'Ok', durations: [d.map((m) => m / 1.25)], distances: [d] }));
      return;
    }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      const feats = photonAnswer(u.searchParams.get('q'), u.searchParams.get('lang') || 'default', u.searchParams.getAll('osm_tag'));
      res.end(JSON.stringify({ type: 'FeatureCollection', features: feats }));
      return;
    }
    if (u.pathname === '/reverse') {
      const tag = u.searchParams.get('osm_tag');
      const at = [Number(u.searchParams.get('lon')), Number(u.searchParams.get('lat'))];
      const within = (e) => haversine(at, e.c) <= Number(u.searchParams.get('radius')) * 1000;
      const rows = OSM_LODGING.filter((e) => e.tags.name && `tourism:${e.tags.tourism}` === tag && within(e));
      res.end(JSON.stringify({ type: 'FeatureCollection', features: rows.map((e) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: e.c },
        properties: { osm_type: e.type[0].toUpperCase(), osm_id: e.id, osm_key: 'tourism', osm_value: e.tags.tourism, name: e.tags.name } })) }));
      return;
    }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        // around:R,lat,lng as Overpass reads it
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        const elements = /"tourism"~/.test(q) ? OSM_LODGING.filter(near).map((e) => (e.type === 'node' ? { type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags } : { type: e.type, id: e.id, center: { lon: e.c[0], lat: e.c[1] }, tags: e.tags })) : [];
        res.end(JSON.stringify({ elements }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}

const baseEnv = () => ({ ...process.env, ...NO_WIKIPEDIA, UW_CACHE: cache, UW_PHOTON: mock.url, UW_OVERPASS: mock.url + '/api/interpreter', UW_OSRM: mock.url, UW_VALHALLA: mock.url,
  UW_NO_CACHE: '1', UW_TURN_BUDGET: '0' });
const uw = (args, env = {}, { node = [] } = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(process.execPath, [...node, UW, ...args], { cwd: tmp, env: { ...baseEnv(), ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => {
    clearTimeout(t);
    let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} }
    resolve({ code, out, err, json, ms: Date.now() - t0 });
  });
});
const readFC = (site, layer) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${layer}.geojson`), 'utf8'));
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const byId = (fc) => Object.fromEntries(fc.features.map((f) => [f.properties.id, f]));

// a small national register around S (same row shape as ~/.cache/uw/tw-hotels/national.json)
const row = (o) => ({ alt: [], licField: 'HotelLicenseNumber', cls: 3, city: '臺北市', town: '大同區', phones: [], rooms: null, pmin: null, pmax: null, status: 1, web: null, upd: null, address: '', ...o });
const lngLat = (c) => ({ lng: c[0], lat: c[1] });
const REG_ROWS = [
  row({ id: 'Hotel_T_A', lic: '臺北市旅館1001號', name: '阿爾法飯店', ...lngLat(east(150)), rooms: 120, pmin: 2000, pmax: 5000 }),
  row({ id: 'Hotel_T_A2', lic: '臺北市旅館1002號', name: '阿爾法飯店二館', ...lngLat([east(150)[0] + 0.00004, S[1]]), rooms: 118 }), // same building
  row({ id: 'Hotel_T_B', lic: '民宿9號', name: '小巷民宿', ...lngLat(east(60)), cls: 4, rooms: 4 }),
  row({ id: 'Hotel_T_C', lic: '臺北市觀光旅館3號', name: '大觀光飯店', ...lngLat(east(320)), cls: 1, rooms: 300 }),
  row({ id: 'Hotel_T_D', lic: '臺北市旅館1004號', name: '已歇業旅店', ...lngLat(east(30)), rooms: 40, status: 2 }), // closed
  row({ id: 'Hotel_T_E', lic: '臺北市旅館1005號', name: '城市青年旅舍', ...lngLat(east(250)), rooms: 20 }),
  row({ id: 'Hotel_T_F', lic: '臺北市旅館1006號', name: '遠方飯店', ...lngLat(east(1500)), rooms: 80 }),
];

before(async () => {
  await writeRegistryCache(cache);
  const nat = path.join(cache, 'tw-hotels', 'national.json');
  const j = JSON.parse(fs.readFileSync(nat, 'utf8'));
  fs.writeFileSync(nat, JSON.stringify({ ...j, rows: [...j.rows, ...REG_ROWS] }));
  mock = await startMock();
});
after(() => { mock?.server.closeAllConnections?.(); mock?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// uw new --ask
test('new --ask is accepted and becomes the question\'s ask when question gets no --ask', async () => {
  const r = await uw(['new', 'ask-site', '--title', 'Taiwan trip', '--ask', 'Two weeks by train: where to stay?', '--center', '121.5,25.0', '--zoom', '7']);
  assert.equal(r.code, 0, r.err); // before: "unknown flag --ask for new"
  assert.equal(cfgOf('ask-site').description, 'Two weeks by train: where to stay?');
  assert.equal((await uw(['add-point', 'ask-site', '--layer', 'stops', '--at', '121.52,25.05', '--name', 'Taipei', '--id', 'taipei'])).code, 0);
  assert.equal((await uw(['add-point', 'ask-site', '--layer', 'stops', '--at', '121.6,23.99', '--name', 'Hualien', '--id', 'hualien'])).code, 0);
  assert.equal((await uw(['legs', 'ask-site', '--layer', 'trip', '--stops', 'stops:taipei,stops:hualien', '--modes', 'train'])).code, 0);
  const q = await uw(['question', 'ask-site', '--kind', 'plan-route', '--options', 'stops', '--force']);
  assert.equal(q.code, 0, q.err);
  assert.equal(cfgOf('ask-site').question.ask, 'Two weeks by train: where to stay?');
  assert.equal((await uw(['new', 'ask-empty', '--ask', ''])).code, 2);
});

// ---------------------------------------------------------------------------
// uw station
test('rankStations: the city-named station wins; a high-speed station is marked and ranks last for rail, first for hsr', () => {
  const c = [{ name: '花蓮港', name_en: 'Hualien Port', coord: H.port }, { name: '花蓮', name_en: 'Hualien', coord: H.hualien }];
  assert.equal(rankStations(c, { city: 'Hualien', near: H.centre })[0].name, '花蓮');
  assert.equal(rankStations(c, { city: '花蓮', near: H.centre })[0].name, '花蓮', 'local names match too');
  const t = [{ name: '台南', name_en: 'Tainan', coord: T.hsr, hsr: true }, { name: '臺南', name_en: 'Tainan', coord: T.tra }];
  assert.equal(rankStations(t, { city: 'Tainan', near: T.centre })[0].name, '臺南');
  assert.equal(rankStations(t, { city: 'Tainan', near: T.centre, kind: 'hsr' })[0].name, '台南');
  assert.equal(rankStations([{ name: 'Lyon-Saint-Exupéry TGV', coord: [5.0758, 45.721] }], { city: 'Lyon', kind: 'hsr' })[0].hsr, true);
  assert.equal(rankStations(c, { city: 'Hualien', near: [120.0, 22.0], maxKm: 20 }).length, 0, 'far stations are dropped');
  const twice = [{ name: '京都', coord: [135.7584, 34.9846] }, { name: '京都', coord: [135.7588, 34.9853] }];
  assert.equal(rankStations(twice, { city: '京都' }).length, 1, 'one station mapped twice is listed once');
});

test('station: finds the city centre itself, takes only railway stations (not the weather station) and sets nights', async () => {
  assert.equal((await uw(['new', 'st', '--title', 'Trip', '--center', '121.0,23.8', '--zoom', '7'])).code, 0);
  const r = await uw(['station', 'st', '--city', 'Hualien', '--nights', '2', '--json']);
  assert.equal(r.code, 0, r.err);
  const f = byId(readFC('st', 'stations')).hualien;
  assert.deepEqual(f.geometry.coordinates, H.hualien);
  assert.equal(f.properties.name, '花蓮');
  assert.equal(f.properties.name_en, 'Hualien');
  assert.equal(f.properties.kind, 'train_station');
  assert.equal(f.properties.nights, 2);
  assert.equal(f.properties.station_of, 'Hualien');
  // every station search carried the station filter; the city centre came from a place search
  const apiHits = mock.hits.filter((h) => h.startsWith('/api') && /q=Hualien&/.test(h));
  assert.ok(apiHits.some((h) => /osm_tag=place%3Acity/.test(h)), 'looked up the city centre');
  assert.ok(apiHits.filter((h) => !/place%3A/.test(h)).every((h) => /osm_tag=railway%3Astation/.test(h)));
  const cfg = cfgOf('st');
  assert.ok(cfg.layers.some((l) => l.id === 'stations' && l.type === 'points'));
  assert.ok(cfg.attribution.some((a) => /OpenStreetMap/.test(a)));
  // re-running upserts the same id; --pick takes the alternative
  assert.equal((await uw(['station', 'st', '--city', 'Hualien', '--pick', '2'])).code, 0);
  assert.equal(readFC('st', 'stations').features.length, 1);
  assert.deepEqual(byId(readFC('st', 'stations')).hualien.geometry.coordinates, H.port);
  // nothing named like the city: exit 2, nothing written
  const none = await uw(['station', 'st', '--city', 'Atlantis', '--near', '121.0,23.8']);
  assert.equal(none.code, 2);
  assert.equal(readFC('st', 'stations').features.length, 1);
});

test('station --kind hsr: a station with the plain city name is recognised as high-speed by an HSR-named object next to it', async () => {
  assert.equal((await uw(['new', 'hsr', '--title', 'Trip', '--center', '120.3,23.0', '--zoom', '8'])).code, 0);
  assert.equal((await uw(['station', 'hsr', '--city', 'Tainan', '--nights', '2'])).code, 0);
  const r = await uw(['station', 'hsr', '--city', 'Tainan', '--kind', 'hsr', '--id', 'tainan-hsr', '--nights', '0', '--json']);
  assert.equal(r.code, 0, r.err);
  const fc = byId(readFC('hsr', 'stations'));
  assert.deepEqual(fc.tainan.geometry.coordinates, T.tra, 'rail: the TRA station in town');
  assert.equal(fc.tainan.properties.station_kind, 'rail');
  assert.deepEqual(fc['tainan-hsr'].geometry.coordinates, T.hsr, 'hsr: the high-speed station out of town');
  assert.equal(fc['tainan-hsr'].properties.station_kind, 'hsr');
  assert.equal(fc['tainan-hsr'].properties.emoji, '🚄');
});

// ---------------------------------------------------------------------------
// uw stay
test('rankStays: walk time ranks, B&Bs and tiny places pay a penalty, one pick per building, reasons in plain words', () => {
  const c = (name, m, o = {}) => ({ name, coord: east(m), walk_min: Math.max(1, Math.round(m / 80)), walk_m: m, walk_basis: 'routed', registered: true, cls: 'hotel', group: 'hotel', rooms: 50, ...o });
  const picks = rankStays([
    c('B&B next door', 60, { group: 'bnb', cls: 'bnb', rooms: 4 }), c('Alpha', 150), c('Alpha annex', 152), c('Big', 400, { cls: 'tourist_hotel', rooms: 300 }), c('Tiny', 100, { rooms: 6 }),
  ], { max: 3, to: 'Shuanglian' });
  assert.deepEqual(picks.map((p) => p.name), ['Alpha', 'Tiny', 'Big']);
  assert.match(picks[0].why, /^2 min walk to Shuanglian · registered hotel, 50 rooms$/);
  assert.deepEqual(picks[0].how, [{ label: 'Walk', text: '150 m along the streets, routed on OpenStreetMap (OSRM, FOSSGIS)' }]);
  assert.match(picks[2].why, /registered tourist hotel, 300 rooms/);
  const est = rankStays([c('Est', 300, { walk_basis: 'est.' })], { to: 'X' });
  assert.match(est[0].why, /^about 4 min walk to X · /);
  assert.equal(est[0].how[0].text, '300 m, estimated from the straight line');
  const osm = rankStays([c('Nord', 200, { registered: false, osm_kind: 'hotel', stars: '4' })], { to: 'X' });
  assert.match(osm[0].why, /^3 min walk to X · hotel, 4★$/);
  assert.deepEqual(osm[0].how.map((x) => x.label), ['Walk', 'Kind and stars']);
});

test('stay (Taiwan): register lodging by routed walk to the station, closed listings out, reasons, English name from OSM, per-stop reruns', async () => {
  assert.equal((await uw(['new', 'tw', '--title', 'Taipei', '--center', S.join(','), '--zoom', '14'])).code, 0);
  assert.equal((await uw(['add-point', 'tw', '--layer', 'stations', '--at', S.join(','), '--name', 'Shuanglian', '--id', 'sl'])).code, 0);
  const r = await uw(['stay', 'tw', '--near', 'stations:sl', '--json']);
  assert.equal(r.code, 0, r.err);
  const picks = r.json.picks;
  assert.equal(picks.length, 3);
  // A (150 m, 120 rooms) first; its annex 4 m away is the same building; the hostel (by name, 250 m) and the tourist
  // hotel (320 m) follow (the fixture's 丰居旅店 at ~395 m is fourth);
  // the closed listing 30 m away and the B&B (enough hotels in range) are not picks; the 1.5 km one is out of range
  assert.deepEqual(picks.map((p) => p.tw_hotel_id), ['Hotel_T_A', 'Hotel_T_E', 'Hotel_T_C']);
  assert.equal(picks[0].name_en, 'Alpha Hotel', 'English name from OpenStreetMap');
  assert.equal(picks[0].id, 'sl-alpha-hotel');
  assert.equal(picks[0].walk_basis, 'routed');
  assert.match(picks[0].why, /^\d+ min walk to Shuanglian · registered hotel, 120 rooms$/);
  assert.match(picks[0].how[0].text, /^\d+ m along the streets, routed on OpenStreetMap/);
  assert.match(picks[1].why, /registered hotel \(a hostel by its name\), 20 rooms/);
  assert.match(picks[2].why, /registered tourist hotel, 300 rooms/);
  assert.equal(picks[0].stop, 'sl');
  assert.equal(picks[0].tw_price_min, 2000, 'filed rates kept as tw_* (never called a price)');
  assert.ok(!/NT\$|price/i.test(picks.map((p) => p.why).join(' ')), 'the reason never mentions a price');
  assert.match(picks[0].source, /data\.gov\.tw 7780/);
  assert.ok(r.json.candidates >= 5);
  assert.ok(cfgOf('tw').attribution.some((a) => /交通部觀光署/.test(a)));
  // --kinds hotel: no hostel; within 350 m fewer than 3 hotels, so the B&B comes in (with its penalty, last)
  const h = await uw(['stay', 'tw', '--near', 'stations:sl', '--kinds', 'hotel', '--radius', '350', '--json']);
  assert.equal(h.code, 0, h.err);
  assert.deepEqual(h.json.picks.map((p) => p.tw_hotel_id), ['Hotel_T_A', 'Hotel_T_C', 'Hotel_T_B']);
  assert.equal(h.json.picks[2].kind, 'guest_house');
  // a rerun for the same stop replaces its picks; another stop's picks stay
  assert.equal((await uw(['add-point', 'tw', '--layer', 'stations', '--at', east(1500).join(','), '--name', 'Far', '--id', 'far'])).code, 0);
  assert.equal((await uw(['stay', 'tw', '--near', 'stations:far', '--max', '1'])).code, 0);
  const all = readFC('tw', 'stays').features;
  assert.equal(all.filter((f) => f.properties.stop === 'sl').length, 3);
  assert.equal(all.filter((f) => f.properties.stop === 'far').length, 1);
  assert.equal(readFC('tw', 'stays').uw.cmd, 'stay');
  // nothing in range: exit 2
  assert.equal((await uw(['add-point', 'tw', '--layer', 'stations', '--at', east(5000).join(','), '--name', 'Void', '--id', 'void'])).code, 0);
  const none = await uw(['stay', 'tw', '--near', 'stations:void', '--radius', '300']);
  assert.equal(none.code, 2, none.out + none.err);
  assert.match(none.out, /No lodging within 300 m of Void/);
  // routing down: the walks are straight-line estimates, said so
  const e = await uw(['stay', 'tw', '--near', 'stations:sl', '--json'], { UW_OSRM: mock.url + '/osrm404' });
  assert.equal(e.code, 0, e.err);
  assert.ok(e.json.picks.every((p) => p.walk_basis === 'est.' && /^about \d+ min walk to /.test(p.why) && /estimated from the straight line/.test(p.how[0].text)));
});

test('stay (elsewhere): OpenStreetMap lodging; Photon stands in when Overpass is busy (marked partial)', async () => {
  assert.equal((await uw(['new', 'ams', '--title', 'Amsterdam', '--center', AMS.join(','), '--zoom', '14'])).code, 0);
  assert.equal((await uw(['add-point', 'ams', '--layer', 'stations', '--at', AMS.join(','), '--name', 'Amsterdam Centraal', '--id', 'cs'])).code, 0);
  const r = await uw(['stay', 'ams', '--near', 'stations:cs', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.source, 'OpenStreetMap');
  const names = r.json.picks.map((p) => p.name);
  assert.equal(names[0], 'Hotel Nord');
  assert.ok(!names.includes(undefined));
  assert.match(r.json.picks[0].why, /hotel, 4★$/);
  assert.doesNotMatch(r.json.picks[0].why, /OpenStreetMap|OSM|routed|est\./);
  assert.equal(r.json.picks[0].osm_id, 'osm-n501');
  assert.ok(cfgOf('ams').attribution.some((a) => /OpenStreetMap/.test(a)));
  const busy = await uw(['stay', 'ams', '--near', 'stations:cs', '--json', '--timeout', '30'], { UW_OVERPASS: mock.url + '/busy/api/interpreter' });
  assert.equal(busy.code, 0, busy.err);
  assert.match(busy.json.partial, /Overpass could not answer/);
  assert.ok(busy.json.picks.length >= 1);
});

test('stay keeps a hotel with the hostels, or says it found none', async () => {
  assert.equal((await uw(['new', 'lx', '--title', 'Lisbon', '--center', LX.join(','), '--zoom', '14'])).code, 0);
  const r = await uw(['stay', 'lx', '--near', LX.join(','), '--near-label', 'Baixa', '--stop', 'lisboa', '--json']);
  assert.equal(r.code, 0, r.err);
  const kinds = r.json.picks.map((p) => p.kind);
  assert.equal(r.json.picks.length, 3);
  assert.ok(kinds.includes('hotel'), `a hotel among ${kinds}`);
  assert.ok(kinds.includes('hostel'));
  assert.equal(r.json.picks.find((p) => p.kind === 'hotel').name, 'Hotel Rua Augusta');
  assert.deepEqual(r.json.picks.map((p) => p.rank), [1, 2, 3], 'ranked by walk');
  assert.equal(r.json.no_hotel, undefined);
  // --kinds hostel: hostels only, and no word about hotels
  const h = await uw(['stay', 'lx', '--near', LX.join(','), '--near-label', 'Baixa', '--stop', 'lisboa', '--kinds', 'hostel', '--json']);
  assert.ok(h.json.picks.every((p) => p.kind === 'hostel'));
  assert.equal(h.json.no_hotel, undefined);
  // hostels only in range: said, in the line the reply copies
  const far = lx(3000, -3000).join(',');
  const n = await uw(['stay', 'lx', '--near', far, '--near-label', 'Almada', '--stop', 'almada']);
  assert.equal(n.code, 0, n.err);
  assert.match(n.out, /No hotel within 800 m of Almada\./);
  assert.match(n.out, /Tell the user: .*no hotel was found within 800 m of Almada\./);
  const j = await uw(['stay', 'lx', '--near', far, '--near-label', 'Almada', '--stop', 'almada', '--json']);
  assert.equal(j.json.no_hotel, true);
});

// Review of 0.1.11: the hotel took the place of "the last pick of a kind that has more than one", so with one pick,
// with picks of different kinds, or with the hotel in the building of the pick it would replace, no hotel was picked,
// and `uw stay` then said "No hotel within 800 m" while one was 450 m away.
test('a hotel in range is a pick whatever the other picks are, and never called missing', async () => {
  const k = new Set(['hotel', 'hostel']);
  const c = (name, m, o = {}) => ({ name, coord: east(m), walk_min: Math.max(1, Math.round(m / 80)), walk_m: m, walk_basis: 'routed', registered: false, group: 'hotel', osm_kind: 'hostel', ...o });
  const hotel = (name, m) => c(name, m, { osm_kind: 'hotel' });
  assert.deepEqual(rankStays([c('Hostel A', 80), hotel('Hotel H', 400)], { max: 1, kinds: k }).map((p) => p.name), ['Hotel H'], 'one pick');
  assert.deepEqual(rankStays([c('Hostel A', 80), c('Guest B', 120, { group: 'bnb', osm_kind: 'guest_house' }), hotel('Hotel H', 400)], { max: 2, kinds: k }).map((p) => p.name),
    ['Hostel A', 'Hotel H'], 'picks of different kinds');
  assert.deepEqual(rankStays([c('Hostel A', 80), c('Hostel B', 160), c('Hostel C', 240), hotel('Hotel C', 250)], { max: 3, kinds: k }).map((p) => p.name),
    ['Hostel A', 'Hostel B', 'Hotel C'], 'a hotel in the building of the hostel it replaces');
  assert.deepEqual(rankStays([c('Hostel A', 80), hotel('Hotel H', 400)], { max: 1, kinds: new Set(['hostel']) }).map((p) => p.name), ['Hostel A'], 'hostels asked for');
  // the CLI: one pick near Baixa is the hotel 450 m away, and nothing says there is none
  const one = await uw(['stay', 'lx', '--near', LX.join(','), '--near-label', 'Baixa', '--stop', 'lisboa', '--max', '1']);
  assert.equal(one.code, 0, one.err);
  assert.match(one.out, /1\. Hotel Rua Augusta/);
  assert.doesNotMatch(one.out, /No hotel|no hotel/);
});

// A "3 days in Lisbon" turn ran `uw stay` three times while Overpass was busy: each waited on it for up to two
// minutes (its limit), the turn ended with all three still running, and the map had no places to stay. It now answers
// within its own limit (30 s) with what the place search found, or says plainly that it found none.
test('Overpass never answers: uw stay answers within its 30 s with the place search\'s picks, hotels and hostels both', { timeout: 120000 }, async () => {
  assert.equal((await uw(['new', 'lxb', '--title', 'Lisbon', '--center', LX.join(','), '--zoom', '14'])).code, 0);
  const hang = { UW_OVERPASS: mock.url + '/hang/api/interpreter' };
  const near = ['--near', LX.join(','), '--near-label', 'Baixa'];
  const [hotels, hostels] = await Promise.all([
    uw(['stay', 'lxb', ...near, '--stop', 'baixa', '--kinds', 'hotel', '--json'], hang),
    uw(['stay', 'lxb', ...near, '--stop', 'baixa-hostels', '--kinds', 'hostel', '--json'], hang),
  ]);
  for (const [r, kind] of [[hotels, 'hotel'], [hostels, 'hostel']]) {
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(r.ms < 31000, `${kind}s: answered after ${r.ms} ms, past its 30 s`);
    assert.match(r.json.partial, /Overpass could not answer/);
    assert.ok(r.json.picks.length >= 1 && r.json.picks.every((p) => p.kind === kind), `${kind}s: ${r.json.picks.map((p) => `${p.name} (${p.kind})`)}`);
    assert.ok(r.json.picks.every((p) => /^\d+ min walk to Baixa · /.test(p.why)), 'walked, with time left after the search');
  }
  assert.equal(hotels.json.picks[0].name, 'Hotel Rua Augusta');
  assert.deepEqual(hostels.json.picks.map((p) => p.name).sort(), ['Downtown Rooms Hostel', 'Draft Hostel', 'Lounge Hostel']);
  const written = readFC('lxb', 'stays').features.map((f) => f.properties.stop);
  assert.ok(written.includes('baixa') && written.includes('baixa-hostels'), 'both runs wrote their picks');
});

test('nothing answers in time: uw stay says plainly it found none, within its limit, and how to try again', { timeout: 60000 }, async () => {
  assert.equal((await uw(['new', 'lxn', '--title', 'Lisbon', '--center', LX.join(','), '--zoom', '14'])).code, 0);
  const env = { UW_OVERPASS: mock.url + '/hang/api/interpreter', UW_PHOTON: mock.url + '/hang' };
  const args = ['stay', 'lxn', '--near', LX.join(','), '--near-label', 'Baixa', '--stop', 'baixa', '--timeout', '10'];
  const r = await uw(args, env);
  assert.equal(r.code, 4, r.out + r.err);
  assert.ok(r.ms < 12000, `answered after ${r.ms} ms`);
  assert.match(r.out, /^No places to stay found near Baixa: the lodging search did not answer in time/m);
  assert.match(r.out, /^Tell the user: places to stay near Baixa were not looked up yet \(the search was busy\)\.$/m);
  assert.match(r.out, /^Try again later: uw stay lxn --near -9\.1372,38\.7101 --near-label Baixa --stop baixa --timeout 120$/m);
  const j = await uw([...args, '--json'], env);
  assert.equal(j.code, 4);
  assert.equal(j.json.none_found, true);
  assert.deepEqual(j.json.picks, []);
  assert.doesNotMatch(j.json.retry, /--json|--timeout 10/);
  assert.ok(!fs.existsSync(path.join(tmp, 'lxn', 'data', 'stays.geojson')), 'nothing written');
});

test('a lodging register that cannot answer in time gives way to OpenStreetMap, within the limit', { timeout: 120000 }, async () => {
  // a first download of the register on a slow link (no cached copy); the preload holds every register request open
  const cold = path.join(tmp, 'cold-cache');
  const env = { UW_CACHE: cold };
  assert.equal((await uw(['new', 'twc', '--title', 'Taipei', '--center', S.join(','), '--zoom', '14'])).code, 0);
  assert.equal((await uw(['add-point', 'twc', '--layer', 'stations', '--at', S.join(','), '--name', 'Shuanglian', '--id', 'sl'])).code, 0);
  const r = await uw(['stay', 'twc', '--near', 'stations:sl', '--json'], env, { node: ['--import', pathToFileURL(path.join(HERE, 'hang-register-fetch.mjs')).href] });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(r.ms < 31000, `answered after ${r.ms} ms`);
  assert.match(r.err, /Taiwan lodging register unavailable .*; using OpenStreetMap/);
  assert.equal(r.json.source, 'OpenStreetMap');
  assert.deepEqual(r.json.picks.map((p) => p.name), ['Shuanglian Inn']);
});

// ---------------------------------------------------------------------------
// uw legs --follow, --source-url
// A "U"-shaped rail line from A to B (the straight line would cut across), a branch that meets it at a T-junction
// without a shared vertex (simplified OSM), a straight high-speed line A–B, and a stop D far from any track.
const A = [121.0, 23.5], B = [121.1, 23.5];
const U = [A, [121.0, 23.6], [121.1, 23.6], B];
const C = [121.05, 23.75];
const BRANCH = [[121.05, 23.6015], C]; // ends ~170 m from the line's middle segment
const D = [121.6, 23.0];
function railFC() {
  const line = (coords, kind, name) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind, name } });
  return { type: 'FeatureCollection', features: [line(U, 'rail', 'U line'), line(BRANCH, 'rail', 'Branch'), line([A, B], 'hsr', 'HSR')], uw: { cmd: 'lines' } };
}

test('rail graph: paths follow the track, through T-junctions with no shared vertex; no track = null', () => {
  const fc = railFC();
  const rail = buildGraph(fc, { filter: (f) => f.properties.kind === 'rail' });
  const ab = trackPath(rail, A, B);
  assert.ok(ab, 'a path along the U');
  assert.ok(ab.km > 30 && ab.km < 33, `~31 km along the U, got ${ab.km}`);
  assert.ok(ab.coords.some((c) => c[1] >= 23.59), 'goes up the U, not straight across');
  const bc = trackPath(rail, B, C);
  assert.ok(bc, 'the branch is joined to the line it ends beside');
  // up the U (11 km), west along its top to the junction (5 km), up the branch (16.5 km)
  assert.ok(bc.km > 31 && bc.km < 35, `B → C ≈ 33 km, got ${bc.km}`);
  assert.ok(bc.coords.some((c) => Math.abs(c[0] - 121.05) < 0.002 && Math.abs(c[1] - 23.6) < 0.003), 'through the junction');
  assert.equal(trackPath(rail, A, D), null, 'no track near D');
  const hsr = buildGraph(fc, { filter: (f) => f.properties.kind === 'hsr' });
  assert.ok(trackPath(hsr, A, B).km < 11);
});

test('legs --follow: train legs on the rail track, hsr legs on the high-speed line, arcs where there is no track; timetable links', async () => {
  assert.equal((await uw(['new', 'lg', '--title', 'Legs', '--center', '121.1,23.5', '--zoom', '8'])).code, 0);
  for (const [id, c] of Object.entries({ a: A, b: B, c: C, d: D })) assert.equal((await uw(['add-point', 'lg', '--layer', 'stops', '--at', c.join(','), '--name', id.toUpperCase(), '--id', id])).code, 0);
  fs.writeFileSync(path.join(tmp, 'lg', 'data', 'rail.geojson'), JSON.stringify(railFC()));
  const TRA = 'https://tip.railway.gov.tw/tra-tip-web/tip';
  const r = await uw(['legs', 'lg', '--layer', 'trip', '--stops', 'stops:a,stops:b,stops:c,stops:d,stops:a', '--modes', 'train,train,train,hsr', '--follow', 'rail',
    '--durations', '35m,,,', '--source', 'TRA timetable', '--source-url', `${TRA},${TRA},,`, '--no-source-check', '--json']);
  assert.equal(r.code, 0, r.err);
  const legs = byId(readFC('lg', 'trip'));
  assert.equal(legs['leg-1'].properties.track, true);
  assert.ok(legs['leg-1'].geometry.coordinates.length > 2, 'the track geometry, not two points');
  assert.ok(legs['leg-1'].properties.distance_km > 30, 'distance is along the track');
  assert.equal(legs['leg-1'].properties.duration_source_url, TRA);
  assert.equal(legs['leg-1'].properties.duration, '35 min');
  assert.equal(legs['leg-2'].properties.timetable_url, TRA, 'a link without a duration is where to check the times');
  assert.equal(legs['leg-2'].properties.duration, undefined, 'never a guessed duration');
  assert.equal(legs['leg-2'].properties.track, true);
  assert.equal(legs['leg-3'].properties.track, undefined, 'C → D: no track, stays an arc');
  assert.equal(legs['leg-3'].geometry.coordinates.length, 2);
  assert.deepEqual(r.json.no_track, [legs['leg-3'].properties.name, legs['leg-4'].properties.name]);
  // D → A is hsr but D has no track at all; an hsr A → B leg takes the straight high-speed line
  const h = await uw(['legs', 'lg', '--layer', 'hsr', '--stops', 'stops:a,stops:b', '--modes', 'hsr', '--follow', 'rail', '--json']);
  assert.equal(h.code, 0, h.err);
  assert.ok(byId(readFC('lg', 'hsr'))['leg-1'].properties.track_km < 11);
  // links must be https
  assert.equal((await uw(['legs', 'lg', '--layer', 'x', '--stops', 'stops:a,stops:b', '--source-url', 'http://example.org'])).code, 2);
  // the track layer is missing (uw lines was skipped while Overpass was busy): arcs, exit 0, and it says what to run
  const miss = await uw(['legs', 'lg', '--layer', 'nolines', '--stops', 'stops:a,stops:b', '--follow', 'tracks', '--json']);
  assert.equal(miss.code, 0, miss.err);
  assert.equal(miss.json.follow_missing, 'tracks');
  assert.match(miss.err, /no such lines layer yet.*uw lines lg --layer tracks/s);
  assert.equal(readFC('lg', 'nolines').features[0].geometry.coordinates.length, 2);
  // without --follow nothing changes: two-point arcs
  assert.equal((await uw(['legs', 'lg', '--layer', 'plain', '--stops', 'stops:a,stops:b'])).code, 0);
  assert.equal(readFC('lg', 'plain').features[0].geometry.coordinates.length, 2);
  assert.equal(readFC('lg', 'plain').features[0].properties.track, undefined);
});

// ---------------------------------------------------------------------------
// uw plan
const stop = (id, city, coord, extra = {}) => ({ id, layer: 'stations', coord, props: { id, station_of: city, ...extra } });
const feat = (layer, id, coord, props) => Object.assign({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { id, ...props } }, { _layer: layer });

test('buildPlan: dates, nights and travel days add up for the Taiwan loop; a 0-night stop shares the travel day', () => {
  const stops = [stop('taipei', 'Taipei', [121.517, 25.046]), stop('hualien', 'Hualien', H.hualien), stop('taitung', 'Taitung', [121.122, 22.793]),
    stop('kaohsiung', 'Kaohsiung', [120.302, 22.639]), stop('tainan', 'Tainan', T.tra), stop('tainan-hsr', 'Tainan', T.hsr, { station_kind: 'hsr' }), stop('taipei', 'Taipei', [121.517, 25.046])];
  const legs = stops.slice(1).map((b, i) => feat('trip', `leg-${i + 1}`, [0, 0], { order: i + 1, from: stops[i].id, to: b.id, emoji: i === 5 ? '🚄' : '🚆',
    ...(i === 0 ? { duration: '2h10', duration_source: 'TRA timetable', duration_source_url: 'https://tip.railway.gov.tw/x' } : { timetable_url: 'https://tip.railway.gov.tw/x' }) }));
  const stays = [feat('stays', 'taipei-a', [0, 0], { stop: 'taipei', rank: 1, name: '天成大飯店', name_en: 'Cosmos Hotel', walk_min: 1 }), feat('stays', 'taipei-b', [0, 0], { stop: 'taipei', rank: 2, name: 'B' })];
  const sights = [feat('sights', 'dihua', [121.51, 25.06], { stop: 'taipei', name_en: 'Dihua Street', source_url: 'https://en.wikipedia.org/wiki/Dihua_Street', source: 'Wikipedia' }),
    feat('sights', 'beitou', [121.507, 25.137], { name_en: 'Beitou Hot Spring Museum' }), // no "stop": nearest stop (Taipei)
    feat('sights', 'taroko', [121.62, 24.155], { stop: 'hualien', name_en: 'Taroko Gorge', source_url: 'https://www.taroko.gov.tw/', source: 'Taroko National Park' })];
  const plan = buildPlan({ stops, nights: [3, 2, 2, 3, 2, 0, 2], start: '2026-10-20', legs, stays, sights });
  assert.equal(plan.days.length, 15, '14 nights = 15 days');
  assert.equal(plan.days[0].title, 'Tue 20 Oct · Taipei');
  assert.equal(plan.days[3].title, 'Fri 23 Oct · Taipei → Hualien');
  assert.equal(plan.days[3].text, 'Travel day; night 1 of 2 in Hualien.');
  assert.equal(plan.days[12].title, 'Sun 1 Nov · Tainan → Tainan HSR → Taipei', 'the 0-night HSR stop is on the same day');
  assert.equal(plan.days[14].title, 'Tue 3 Nov · Taipei: depart');
  // travel items: the leg with its sourced duration and link; never a duration without a source
  const leg1 = plan.days[3].items[0];
  assert.equal(leg1.text, '🚆 Taipei → Hualien · 2h10 (TRA timetable)');
  assert.deepEqual(leg1.ref, { layer: 'trip', id: 'leg-1' });
  assert.equal(leg1.url, 'https://tip.railway.gov.tw/x');
  // no page gave a time: a labelled estimate from the distance, never a bare "check the timetable" (r5)
  assert.match(plan.days[5].items[0].text, /Hualien → Taitung · about [\d.]+ (h|min) by train \(estimate from \d+ km; check the timetable\)/);
  // the base is the rank-1 stay; days focus on it
  assert.equal(plan.days[0].items[0].text, 'Base: Cosmos Hotel (天成大飯店) · 1 min walk to the station');
  assert.deepEqual(plan.days[0].focus, { layer: 'stays', id: 'taipei-a' });
  // sights go on full days with their source link; Taipei's two sights are shared over its two visits
  const items = plan.days.flatMap((d, i) => d.items.map((it) => ({ ...it, day: i })));
  const dihua = items.find((it) => it.ref?.id === 'dihua');
  assert.equal(dihua.url, 'https://en.wikipedia.org/wiki/Dihua_Street');
  assert.equal(dihua.source, 'Wikipedia');
  assert.ok([1, 2].includes(dihua.day), 'on a full Taipei day of the first visit');
  assert.equal(items.find((it) => it.ref?.id === 'beitou').day, 13, 'the second visit gets the other one');
  assert.equal(items.find((it) => it.ref?.id === 'taroko').day, 4, 'Hualien\'s full day');
  assert.throws(() => buildPlan({ stops, nights: [3, 2], start: '2026-10-20' }), /--nights has 2 values for 7 stops/);
});

test('plan (CLI): writes a plan validate accepts, sums nights per stop, refuses to overwrite without --force; validate checks item links', async () => {
  const r = await uw(['plan', 'lg', '--stops', 'stops', '--ids', 'a,b,c,a', '--nights', '2,1,1,1', '--start', '2026-10-20', '--legs', 'trip', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.days, 6);
  const cfg = cfgOf('lg');
  assert.equal(cfg.plan.days[0].title, 'Tue 20 Oct · A');
  assert.equal(byId(readFC('lg', 'stops')).a.properties.nights, 3, 'A: 2 + 1 nights over two visits');
  const v = await uw(['validate', 'lg']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.equal((await uw(['plan', 'lg', '--stops', 'stops', '--ids', 'a,b', '--nights', '1,1', '--start', '2026-10-20'])).code, 1, 'existing plan kept');
  assert.equal((await uw(['plan', 'lg', '--stops', 'stops', '--ids', 'a,b', '--nights', '1,1', '--start', '20 Oct'])).code, 2, 'dates are YYYY-MM-DD');
  // a plan item link must be https
  cfg.plan.days[0].items.push({ text: 'Bad link', url: 'javascript:alert(1)' });
  fs.writeFileSync(path.join(tmp, 'lg', 'map.config.json'), JSON.stringify(cfg, null, 2));
  const bad = await uw(['validate', 'lg']);
  assert.equal(bad.code, 1);
  assert.match(bad.out + bad.err, /items\[\d+\]\.url/);
});

// ---------------------------------------------------------------------------
// uw handoff (research-team files → the itinerary steps)
test('handoff: checks instafy.research@1 files and turns them into steps, day facts and the unverified list', async () => {
  const { checkHandoff, planFromHandoff } = await lib('cmd-handoff.mjs');
  const good = { schema: 'instafy.research@1', item: 'Hualien', kind: 'city', summary: 'East coast base',
    facts: [{ text: 'Many Taroko trails are closed', source_url: 'https://www.taroko.gov.tw/', retrieved_at: '2026-10-14', confidence: 'high' },
      { text: 'A rumoured new bus', source_url: 'https://example.org/x', confidence: 'low' }, { text: 'No source here', confidence: 'high' }],
    places: [{ name: 'Hualien Station', query: '花蓮車站', kind: 'station', why: 'TRA', source_url: 'https://www.railway.gov.tw/' },
      { name: 'Chantai Hotel', query: '仟台大飯店', kind: 'hotel', why: '2 min from the station', source_url: 'https://example.org/chantai', lat: 23.99, lng: 121.6 },
      { name: 'Qixingtan', query: '七星潭', kind: 'sight', why: 'pebble beach', source_url: 'https://en.wikipedia.org/wiki/Qixingtan_Beach' },
      { name: 'Unsourced cafe', query: 'x', kind: 'food', why: 'nice' }],
    legs: [{ from: 'Taipei', to: 'Hualien', mode: 'train', duration_min: 130, source_url: 'https://tip.railway.gov.tw/x' }, { from: 'Hualien', to: 'Taitung', mode: 'train' }],
    unknowns: ['Hotel prices'] };
  const c = checkHandoff(good);
  assert.equal(c.ok, true);
  assert.ok(c.errors.some((e) => /places\[1\] carries "lat": ignored/.test(e)), 'coordinates in a handoff are never used');
  assert.equal(checkHandoff({ ...good, schema: 'x' }).ok, false);
  const plan = planFromHandoff([c.item], 'trip');
  assert.ok(plan.steps.some((s) => s.startsWith('uw station trip --city "Hualien" --nights <N>')));
  // research picks are for a traveller who asked for hotels: the step asks for hotels
  assert.ok(plan.steps.some((s) => s === 'uw stay trip --near stations:hualien --kinds hotel'));
  const hotel = plan.steps.find((s) => s.includes('--layer stays'));
  assert.match(hotel, /--query "仟台大飯店"/);
  assert.doesNotMatch(hotel, /23\.99|121\.6/, 'no coordinates from the handoff');
  assert.ok(plan.steps.some((s) => /--layer sights --query "七星潭".*"source_url":"https:\/\/en\.wikipedia\.org\/wiki\/Qixingtan_Beach"/.test(s)));
  assert.ok(plan.steps.some((s) => /Taipei → Hualien.*: 2h10, source .*--durations "2h10"/.test(s)));
  assert.deepEqual(plan.dayFacts.map((f) => f.text), ['Many Taroko trails are closed']);
  assert.ok(plan.unverified.includes('Hualien: A rumoured new bus (low confidence)'));
  assert.ok(plan.unverified.includes('Hualien: No source here (no source)'));
  assert.ok(plan.unverified.includes('Hualien: Unsourced cafe (no source)'));
  assert.ok(plan.unverified.includes('Hualien → Taitung: no sourced duration'));
  assert.ok(plan.unverified.includes('Hualien: Hotel prices'));
  // CLI: a folder with one good and one broken file
  const dir = path.join(tmp, 'handoff', 'taiwan-trip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hualien.json'), JSON.stringify(good));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const r = await uw(['handoff', dir, '--site', 'trip', '--json', '--no-source-check']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.items.length, 1);
  assert.ok(r.json.problems.some((p) => /broken\.json: not valid JSON/.test(p)));
  fs.rmSync(path.join(dir, 'hualien.json'));
  assert.equal((await uw(['handoff', dir])).code, 1, 'nothing usable');
  assert.equal((await uw(['handoff', path.join(tmp, 'handoff', 'none')])).code, 1);
});
