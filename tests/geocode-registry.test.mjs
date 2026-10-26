// Tests for registry-backed hotel geocoding in Taiwan, add-point layer registration / view fit and "not found yet".
// Offline: Photon and Overpass are a local mock (UW_PHOTON / UW_OVERPASS), the Taiwan registers a fixture cache (UW_CACHE).
// Run: node --test map-pack/tests/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeRegistryCache, startMock, VIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts');
const UW = path.join(SCRIPTS, 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-test-'));
const cache = path.join(tmp, 'cache');
let mock;
const env = () => ({ ...process.env, UW_CACHE: cache, UW_PHOTON: mock.url, UW_OVERPASS: mock.url + '/api/interpreter', UW_NO_CACHE: '1' });
// async: the mock server runs in this process, so a blocking spawnSync would deadlock it
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: env() });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 60000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
});
const uw = async (...args) => {
  const r = await run(args);
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.out); } catch {} }
  return { ...r, json };
};
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const featsOf = (site, layer = 'hotels') => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${layer}.geojson`), 'utf8')).features;
const NEAR = VIA.join(',');
const newSite = async (name) => { const r = await uw('new', name, '--title', 't', '--center', '121.5637,25.0375', '--zoom', '14'); assert.equal(r.code, 0, r.err); };

let reg;
before(async () => {
  await writeRegistryCache(cache);
  process.env.UW_CACHE = cache; // for the in-process registry tests
  mock = await startMock();
  reg = await import(path.join(SCRIPTS, 'lib', 'registry-geo.mjs'));
});
after(() => { mock?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// registry-geo (in process)
test('helpers: lodging words, Taiwan box, website cores, alias similarity', () => {
  assert.ok(reg.isLodging({ query: 'Everstar Hotel, Taipei' }));
  assert.ok(reg.isLodging({ query: '樂爾公寓' }));
  assert.ok(reg.isLodging({ query: 'Lore', layer: 'hotels' }));
  assert.ok(reg.isLodging({ query: 'Lore', kind: 'guest_house' }));
  assert.ok(!reg.isLodging({ query: 'Blue Door Cafe', layer: 'cafes' }));
  assert.ok(reg.inTaiwan(VIA) && reg.inTaiwan([118.32, 24.43]) && !reg.inTaiwan([4.89, 52.37]));
  assert.equal(reg.webCore('https://TaipeiEverStar.com'), 'taipeieverstar');
  assert.equal(reg.webCore('https://www.lorehotel.tw'), 'lorehotel');
  assert.equal(reg.webCore('http://www.waikoloa.com.tw/'), 'waikoloa');
  assert.equal(reg.webCore('https://www.facebook.com/somehotel'), null);
  assert.equal(reg.aliasSim('Everstar Hotel, Taipei', 'taipeieverstar', 'website'), 1);
  assert.equal(reg.aliasSim('Lore Hotel', 'lorehotel', 'website'), 1);
  assert.equal(reg.aliasSim('Lore Hotel', 'hoteldeflore', 'website'), 0, 'no substring match for short names');
  assert.equal(reg.aliasSim('Lore Hotel, Taipei', '樂爾公寓 LORE HOTEL', 'description'), 1);
  assert.equal(reg.aliasSim('亞士都飯店', '亞士都酒店', 'name'), 1);
  assert.ok(reg.aliasSim('Explorer Hotel', '樂爾公寓 LORE HOTEL', 'description') < 0.5);
  assert.equal(reg.queryLabel('Everstar Hotel, Taipei'), 'Everstar Hotel');
});

test('registrySearch: Everstar by website (renamed Astar), medium', async () => {
  const r = await reg.registrySearch('Everstar Hotel, Taipei', { near: VIA });
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.equal(c.name, '亞士都酒店');
  assert.deepEqual(c.coord, [121.524711, 25.050524]);
  assert.equal(c.registry.licence_id, '臺北市旅館816號');
  assert.equal(c.confidence, 'medium');
  assert.deepEqual(c.by, ['website']);
  assert.ok(reg.acceptable(c));
});

test('registrySearch: Lore by website + listing name, register name via licence, high', async () => {
  const c = (await reg.registrySearch('Lore Hotel, Taipei', { near: VIA })).candidates[0];
  assert.equal(c.name, '院院樂居');
  assert.equal(c.name_local, '樂爾公寓');
  assert.equal(c.registry.licence_id, '臺北市旅館166號');
  assert.equal(c.registry.register, 'data.taipei/135464');
  assert.equal(c.confidence, 'high');
  assert.deepEqual(c.coord, [121.510855, 25.06345]);
  const zh = (await reg.registrySearch('樂爾公寓', { near: VIA })).candidates[0];
  assert.equal(zh.registry.hotel_id, 'Hotel_A15010000H_019310');
  assert.equal(zh.confidence, 'high');
});

test('registrySearch: range, chains, closed listings and register-only rows', async () => {
  // the Kaohsiung "everstar" website is out of range from Taipei
  const far = await reg.registrySearch('Everstar Hotel', { near: VIA, maxKm: 8 });
  assert.ok(far.candidates.every((c) => c.city === '臺北市'));
  // two branches with one website: ambiguous → low, not acceptable
  const chain = await reg.registrySearch('Kindness Hotel', { near: VIA });
  assert.equal(chain.candidates.length, 2);
  assert.ok(chain.candidates.every((c) => c.confidence === 'low' && !reg.acceptable(c)));
  // a closed listing is never taken automatically
  const closed = (await reg.registrySearch('舊時光旅店', { near: VIA })).candidates[0];
  assert.equal(closed.registry.open, false);
  assert.ok(!reg.acceptable(closed));
  // a Taipei register row without a national row has no coordinates: reported, not placed
  const u = await reg.registrySearch('星空膠囊旅館', { near: VIA });
  assert.equal(u.candidates.length, 0);
  assert.equal(u.unplaced[0].licence_id, '臺北市旅館999號');
});

test('registryProps: provenance, licence id, names', async () => {
  const c = (await reg.registrySearch('Everstar Hotel, Taipei', { near: VIA })).candidates[0];
  const p = reg.registryProps(c, { label: 'Everstar Hotel' });
  assert.equal(p.name, 'Everstar Hotel');
  assert.equal(p.name_en, 'Everstar Hotel');
  assert.equal(p.name_local, '亞士都酒店');
  assert.equal(p.address, '臺北市中山區林森北路98號2樓');
  assert.equal(p.area, 'Zhongshan District');
  assert.equal(p.tw_licence_id, '臺北市旅館816號');
  assert.equal(p.prov.source, 'data.gov.tw/7780');
  assert.equal(p.prov.lane, 'open');
  assert.equal(p.prov.match.confidence, 'medium');
});

// ---------------------------------------------------------------------------
// add-point / geocode (CLI, mock network)
test('add-point: the Taipei hotel request builds a 3-pin map (Photon + registry), layer registered, view framed', async () => {
  await newSite('trip');
  const via = await uw('add-point', 'trip', '--layer', 'hotels', '--query', 'Via Hotel Loft, Taipei', '--near', NEAR, '--id', 'via-loft', '--json');
  assert.equal(via.code, 0, via.err);
  assert.equal(via.json.source, 'photon');
  let cfg = cfgOf('trip');
  const L = cfg.layers.find((l) => l.id === 'hotels');
  assert.equal(L.type, 'points');
  assert.equal(L.tier, 'option');
  assert.equal(L.data, 'data/hotels.geojson');
  assert.equal(L.style.emoji, '🏨');
  assert.ok(Math.abs(cfg.view.center[0] - VIA[0]) < 0.001 && Math.abs(cfg.view.center[1] - VIA[1]) < 0.001, 'view moved to the hotel');

  const ev = await uw('add-point', 'trip', '--layer', 'hotels', '--query', 'Everstar Hotel, Taipei', '--near', NEAR, '--id', 'everstar', '--json');
  assert.equal(ev.code, 0, ev.err);
  assert.equal(ev.json.source, 'registry');
  assert.equal(ev.json.alternatives.length, 2, 'Photon candidates are listed as alternatives');
  assert.match(ev.err, /register match is medium/);
  const lore = await uw('add-point', 'trip', '--layer', 'hotels', '--query', 'Lore Hotel, Taipei', '--near', NEAR, '--id', 'lore');
  assert.equal(lore.code, 0, lore.err);
  assert.match(lore.out, /registry: 院院樂居 \/ 樂爾公寓 · licence 臺北市旅館166號 · match high/);
  assert.match(lore.out, /data\.gov\.tw\/7780 \+ data\.taipei\/135464/);

  const f = Object.fromEntries(featsOf('trip').map((x) => [x.properties.id, x]));
  assert.deepEqual(f.everstar.geometry.coordinates, [121.524711, 25.050524]);
  assert.equal(f.everstar.properties.tw_licence_id, '臺北市旅館816號');
  assert.equal(f.everstar.properties.prov.source, 'data.gov.tw/7780');
  assert.deepEqual(f.lore.geometry.coordinates, [121.510855, 25.06345]);
  assert.equal(f.lore.properties.prov.also, 'data.taipei/135464');
  cfg = cfgOf('trip');
  assert.equal(cfg.layers.length, 1);
  assert.ok(cfg.attribution.some((a) => /交通部觀光署/.test(a)), 'OGDL credit added');
  const [[w, s], [e, n]] = cfg.view.bounds;
  for (const x of Object.values(f)) {
    const [lng, lat] = x.geometry.coordinates;
    assert.ok(lng >= w && lng <= e && lat >= s && lat <= n, `${x.properties.id} inside view.bounds`);
  }
  const v = await uw('validate', 'trip');
  assert.equal(v.code, 0, v.out + v.err);
});

test('add-point: a place nobody can find is listed as "not found yet" and cleared once added', async () => {
  await newSite('miss');
  const r = await uw('add-point', 'miss', '--layer', 'hotels', '--query', 'Qwertyuiop Hotel, Taipei', '--near', NEAR, '--id', 'qwerty');
  assert.equal(r.code, 2);
  assert.match(r.err, /Taiwan lodging registers: no listing named like "Qwertyuiop Hotel"/);
  let cfg = cfgOf('miss');
  assert.equal(cfg.missing.length, 1);
  assert.equal(cfg.missing[0].name, 'Qwertyuiop Hotel');
  assert.ok(cfg.missing[0].tried.some((t) => /Taiwan lodging registers/.test(t)));
  assert.ok(cfg.missing[0].tried.some((t) => /Photon/.test(t)));
  const v = await uw('validate', 'miss');
  assert.equal(v.code, 0);
  assert.match(v.out + v.err, /not found yet: Qwertyuiop Hotel/);
  // Photon only: Everstar is refused (and listed); the registry then finds it and clears the entry
  const p = await uw('add-point', 'miss', '--layer', 'hotels', '--query', 'Everstar Hotel, Taipei', '--near', NEAR, '--id', 'everstar', '--source', 'photon');
  assert.equal(p.code, 2);
  assert.ok(cfgOf('miss').missing.some((m) => m.id === 'everstar'));
  const ok = await uw('add-point', 'miss', '--layer', 'hotels', '--query', 'Everstar Hotel, Taipei', '--near', NEAR, '--id', 'everstar');
  assert.equal(ok.code, 0, ok.err);
  cfg = cfgOf('miss');
  assert.deepEqual(cfg.missing.map((m) => m.name), ['Qwertyuiop Hotel']);
});

test('add-point --source registry: only the registers; refuses low or closed matches', async () => {
  await newSite('src');
  const via = await uw('add-point', 'src', '--layer', 'hotels', '--query', 'Via Hotel Loft, Taipei', '--near', NEAR, '--source', 'registry', '--json');
  assert.equal(via.code, 2);
  assert.equal(via.json.refused, 'registry_no_match');
  const closed = await uw('add-point', 'src', '--layer', 'hotels', '--query', '舊時光旅店', '--near', NEAR, '--source', 'registry');
  assert.equal(closed.code, 2);
  assert.match(closed.err, /NOT OPERATING/);
  const picked = await uw('add-point', 'src', '--layer', 'hotels', '--query', 'Kindness Hotel', '--near', NEAR, '--source', 'registry', '--pick', '2', '--id', 'cs');
  assert.equal(picked.code, 0, picked.err);
  assert.equal(featsOf('src')[0].properties.prov.match.confidence, 'low');
  assert.equal((await uw('add-point', 'src', '--layer', 'hotels', '--query', 'x', '--source', 'nope')).code, 2);
});

test('add-point outside Taiwan never asks the Taiwan registers', async () => {
  const r = await uw('new', 'ams', '--title', 't', '--center', '4.8897,52.3740', '--zoom', '14');
  assert.equal(r.code, 0, r.err);
  const a = await uw('add-point', 'ams', '--layer', 'hotels', '--query', 'Lore Hotel, Taipei', '--near', '4.8897,52.3740');
  assert.equal(a.code, 2, 'nothing found is "not found" (exit 2: a better query may find it), never an error');
  assert.deepEqual(cfgOf('ams').missing[0].tried, ['OpenStreetMap search (Photon)']);
});

test('add-point --tier and non-option layers: no view change, colour set', async () => {
  await newSite('tiers');
  const before = cfgOf('tiers').view;
  const r = await uw('add-point', 'tiers', '--layer', 'cafes', '--query', 'Blue Door Cafe', '--near', NEAR, '--tier', 'context');
  assert.equal(r.code, 0, r.err);
  const cfg = cfgOf('tiers');
  const L = cfg.layers.find((l) => l.id === 'cafes');
  assert.equal(L.tier, 'context');
  assert.equal(L.style.color, '#78350f');
  assert.deepEqual(cfg.view, before);
  const s = await uw('add-point', 'tiers', '--layer', 'stops', '--query', 'Blue Door Cafe', '--near', NEAR, '--id', 'b2');
  assert.equal(cfgOf('tiers').layers.find((l) => l.id === 'stops').tier, 'support');
  assert.equal(s.code, 0, s.err);
  const o = await uw('add-point', 'tiers', '--layer', 'hotels', '--query', 'Via Hotel Loft, Taipei', '--near', NEAR, '--no-fit');
  assert.equal(o.code, 0, o.err);
  assert.deepEqual(cfgOf('tiers').view, before, '--no-fit keeps the view');
});

test('geocode: lodging queries in Taiwan list register candidates when Photon has none nearby', async () => {
  const g = await uw('geocode', 'Everstar Hotel', '--near', NEAR, '--json');
  assert.equal(g.code, 0, g.err);
  assert.equal(g.json.registry[0].registry.licence_id, '臺北市旅館816號');
  assert.ok(g.json.candidates[0].far);
  const p = await uw('geocode', 'Everstar Hotel', '--near', NEAR, '--source', 'photon', '--json');
  assert.equal(p.json.registry, undefined);
});

// ---------------------------------------------------------------------------
// layers register themselves; tw-hotels agrees with add-point; lenses always have something to rank
test('places registers its layer (readable title, no tier) and says so', async () => {
  const r = await uw('places', 'trip', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '1200');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /map\.config\.json: registered layer "mrt"/);
  assert.doesNotMatch(r.out, /Add:/);
  const L = cfgOf('trip').layers.find((l) => l.id === 'mrt');
  assert.equal(L.title, 'Metro stations');
  assert.equal(L.data, 'data/mrt.geojson');
  assert.equal(L.tier, undefined, 'the question decides the tier');
  const again = await uw('places', 'trip', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '1200');
  assert.doesNotMatch(again.out, /registered layer/);
  assert.equal(cfgOf('trip').layers.filter((l) => l.id === 'mrt').length, 1);
});

test('tw-hotels on registry-placed points: add-point\'s confidence wins; other names are flagged', async () => {
  const r = await uw('adapter', 'tw-hotels', 'trip', '--layer', 'hotels', '--json');
  assert.equal(r.code, 0, r.err);
  const by = Object.fromEntries(r.json.results.map((x) => [x.id, x]));
  assert.equal(by.everstar.confidence, 'medium', 'Everstar stays medium (website-only identity match)');
  assert.equal(by.everstar.status, 'uncertain');
  assert.equal(by.everstar.placed_from.confidence, 'medium');
  assert.equal(by.lore.confidence, 'high');
  assert.equal(by.lore.placed_from.confidence, 'high');
  assert.equal(by['via-loft'].placed_from, undefined);
  assert.equal(by['via-loft'].other_name, true, 'Via is registered under its branch name');
  const t = await uw('adapter', 'tw-hotels', 'trip', '--layer', 'hotels');
  assert.match(t.out, /placed on the map from this very listing by add-point.*medium.*tell the user/);
  assert.match(t.out, /registered as "丰居旅店雙連館", not "Via Hotel Loft"/);
});

test('question: a lens with no criterion gets the matching metric at weight 0', async () => {
  const p = path.join(tmp, 'trip', 'data', 'hotels.geojson');
  const fc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const vals = { 'via-loft': [6, 9], everstar: [8, 17], lore: [3, 2] };
  for (const f of fc.features) [f.properties.walk_min_mrt, f.properties.lively_night_blocks] = vals[f.properties.id];
  fs.writeFileSync(p, JSON.stringify(fc));
  fs.writeFileSync(path.join(tmp, 'trip', 'data', 'metrics.json'), JSON.stringify({ metrics: {
    walk_min_mrt: { label: 'Walk to MRT', unit: 'min', better: 'lower', basis: 'routed', confidence: 'high' },
    lively_night_blocks: { label: 'Lively streets', unit: 'blocks', better: 'higher', basis: 'estimated', confidence: 'medium' } } }));
  const r = await uw('question', 'trip', '--kind', 'choose-one', '--options', 'hotels', '--criteria', 'walk_min_mrt:2', '--lenses', 'move,night', '--lens', 'move', '--json');
  assert.equal(r.code, 0, r.err);
  const crit = r.json.question.criteria;
  assert.deepEqual(crit.map((c) => [c.key, c.weight]), [['walk_min_mrt', 2], ['lively_night_blocks', 0]]);
  const night = r.json.question.lenses.find((l) => l.id === 'night');
  assert.equal(night.weights.lively_night_blocks, 3);
  assert.deepEqual(r.json.ranking.map((x) => x.id), ['lore', 'via-loft', 'everstar'], 'the starting lens ranks as before');
  assert.ok(!r.json.warnings.some((w) => /night/.test(w)));
});

test('set name_en clears needs_english (the fix validate S7 suggests works)', async () => {
  const p = path.join(tmp, 'trip', 'data', 'marks.geojson');
  fs.writeFileSync(p, JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: VIA }, properties: { id: 'm1', name: '雙城街', needs_english: true } }] }));
  const r = await uw('set', 'trip', 'marks:m1', '--props', '{"name_en":"Shuangcheng Street"}');
  assert.equal(r.code, 0, r.err);
  const f = JSON.parse(fs.readFileSync(p, 'utf8')).features[0];
  assert.equal(f.properties.name_en, 'Shuangcheng Street');
  assert.equal(f.properties.needs_english, undefined);
  fs.rmSync(p);
});
