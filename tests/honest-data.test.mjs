// Honest data: MRT stations in Taipei come from Taipei Metro's own open data (complete, with entrances), and anything
// incomplete (the Photon fallback, a --limit cut, an option outside the fetched area) is marked partial in the layer,
// carried by enrich into metrics.json, and shown by question + the engine as a caveat ("MRT data partial", in words), never
// as "shortest" / "longest". Offline: mock services (fixtures.mjs) and a fixture tw-metro cache (real rows).
// Run: node --test map-pack/tests/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeRegistryCache, startMock, VIA, TW_METRO } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-honest-'));
const cache = path.join(tmp, 'cache');
let mock;
const env = (extra = {}) => ({ ...process.env, UW_CACHE: cache, UW_PHOTON: mock.url, UW_OVERPASS: mock.url + '/api/interpreter', UW_OSRM: mock.url,
  UW_VALHALLA: mock.url, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0', ...extra });
const uw = (args, extra) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: env(extra) });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 60000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const file = (site, rel) => path.join(tmp, site, rel);
const read = (site, rel) => JSON.parse(fs.readFileSync(file(site, rel), 'utf8'));
const hotels = (site) => Object.fromEntries(read(site, 'data/hotels.geojson').features.map((f) => [f.properties.id, f.properties]));
const NEAR = VIA.join(',');
const HOTELS = [['Via Hotel Loft, Taipei', 'via-loft'], ['Everstar Hotel, Taipei', 'everstar'], ['Lore Hotel, Taipei', 'lore']];
async function site(name, which = HOTELS) {
  assert.equal((await uw(['new', name, '--title', 'Taipei: which hotel?', '--center', NEAR, '--zoom', '14'])).code, 0);
  for (const [q, id] of which) { const r = await uw(['add-point', name, '--layer', 'hotels', '--query', q, '--near', NEAR, '--id', id]); assert.equal(r.code, 0, r.err); }
}
const QUESTION = (s) => ['question', s, '--kind', 'choose-one', '--options', 'hotels', '--criteria', 'walk_min_mrt:2,cafes:1', '--lenses', 'move', '--force', '--json'];
const engine = async () => (await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'question.js')).href)).Question;

before(async () => { await writeRegistryCache(cache); mock = await startMock(); });
after(() => { mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('tw-metro: parses the operator CSVs (stations, entrances, lines); twins merged, typos fixed, nothing invented', async () => {
  const M = await import(pathToFileURL(path.join(SKILL, 'scripts', 'adapters', 'tw-metro.mjs')).href);
  const net = M.parseNetwork(TW_METRO);
  const by = Object.fromEntries(net.stations.map((s) => [s.zh, s]));
  assert.deepEqual(by['大橋頭'].codes, ['O12']);
  assert.equal(by['大橋頭'].en, 'Daqiaotou');
  assert.equal(by['大橋頭'].entrances.length, 4);
  assert.deepEqual(by['大橋頭'].entrances.find((e) => e.ref === '1A'), { ref: '1A', c: [121.511735, 25.063332], step_free: false });
  assert.deepEqual(by['中山'].codes, ['R11', 'G14']);
  assert.deepEqual(by['中山'].lines, ['R', 'G']);
  assert.equal(by['民權西路'].en, 'Minquan W. Rd.', 'the published "Minzuan" slip is corrected');
  assert.equal(by['中山'].address, '10444臺北市中山區南京西路16號', 'first line of a multi-line address, line prefix dropped');
  // a station only the entrance list has: placed at the mean of its entrances, no English name invented
  assert.equal(by['幸福'].from_entrances, true);
  assert.equal(by['幸福'].en, null);
  assert.deepEqual(by['幸福'].c, [121.460191, 25.049943]);
  const feats = M.stationFeatures({ ...net, as_of: '2026-09-03' }, { circles: [[121.510855, 25.06345]], radiusM: 800 });
  const f = feats.find((x) => x.properties.name === '大橋頭');
  assert.equal(f.properties.id, 'trtc-o12');
  assert.equal(f.properties.lane, 'open');
  assert.equal(f.properties.data_licence, 'OGDL-Taiwan-1.0');
  assert.equal(f.properties.line_names, 'Zhonghe-Xinlu Line');
  assert.ok(M.covers(net, [[121.510855, 25.06345]]));
  assert.ok(!M.covers(net, [[120.30, 22.62]]), 'Kaohsiung is outside the Taipei Metro dataset (places then asks OSM)');
});

test('places --kinds mrt_station in Taipei: Taipei Metro open data (no Overpass), Daqiaotou found, Lore ~2-4 min from the MRT', async () => {
  await site('tw');
  const before = mock.hits.length;
  const r = await uw(['places', 'tw', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.source, 'tw-metro');
  assert.equal(r.json.partial, null);
  assert.ok(!mock.hits.slice(before).some((h) => /interpreter|reverse/.test(h)), 'no Overpass / Photon call for metro stations');
  const mrt = read('tw', 'data/mrt.geojson');
  const names = mrt.features.map((f) => f.properties.name_en);
  for (const n of ['Daqiaotou', 'Shuanglian', 'Zhongshan']) assert.ok(names.includes(n), `${n} in ${names}`);
  assert.equal(mrt.source.lane, 'open');
  assert.match(mrt.attribution, /臺北大眾捷運股份有限公司.*政府資料開放授權條款/);
  assert.equal(mrt.uw.args.source, 'tw-metro');
  assert.equal(mrt.uw.partial, undefined);
  assert.equal(mrt.uw.coverage.circles.length, 3);
  const cfg = read('tw', 'map.config.json');
  assert.ok(cfg.attribution.some((a) => /臺北大眾捷運/.test(a)), 'OGDL credit in map.config.json');
  assert.equal(cfg.layers.find((l) => l.id === 'mrt').partial, undefined);
  assert.equal((await uw(['places', 'tw', '--layer', 'cafes', '--kinds', 'cafe', '--around', 'hotels', '--radius', '800'])).code, 0);
  const e = await uw(['enrich', 'tw', '--layer', 'hotels', '--route-to', 'mrt', '--nearest', 'mrt', '--count', 'cafes', '--json']);
  assert.equal(e.code, 0, e.err);
  assert.deepEqual(e.json.partial, []);
  const h = hotels('tw');
  assert.equal(h.lore.walk_min_mrt_name, 'Daqiaotou');
  assert.ok(h.lore.walk_min_mrt >= 1 && h.lore.walk_min_mrt <= 4, `Lore walk ${h.lore.walk_min_mrt} min`);
  assert.ok(h.lore.nearest_mrt_m < 150, `measured to the nearest entrance (exit 1A), ${h.lore.nearest_mrt_m} m`);
  assert.equal(h['via-loft'].walk_min_mrt_name, 'Shuanglian');
  assert.equal(h.everstar.walk_min_mrt_name, 'Zhongshan');
  const m = read('tw', 'data/metrics.json').metrics;
  assert.equal(m.walk_min_mrt.partial, undefined);
  assert.match(m.walk_min_mrt.source, /Taipei Metro open data/);
  assert.equal(m.nearest_mrt_m.scale, 'straight line to the nearest entrance');
  const q = await uw(QUESTION('tw'));
  assert.equal(q.code, 0, q.err);
  assert.deepEqual(q.json.partial, []);
  assert.ok(q.json.verdict.lines.every((l) => !l.caveats.length && !/partial/.test(l.text)));
  assert.equal((await uw(['validate', 'tw'])).code, 0);
});

test('Photon fallback → layer partial → metrics partial → verdict caveat, never "longest"; a complete re-fetch clears it', async () => {
  await site('pf');
  const busy = { UW_OVERPASS: mock.url + '/busy/api/interpreter' };
  const r = await uw(['places', 'pf', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800', '--timeout', '20', '--source', 'osm'], busy);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PARTIAL: Overpass could not answer, so mrt_station came from OpenStreetMap search \(Photon\) .*re-fetch it first: uw places pf --layer mrt .*--force/);
  const mrt = read('pf', 'data/mrt.geojson');
  assert.match(mrt.uw.partial.reason, /Photon/);
  assert.match(mrt.uw.partial.refetch, /^uw places pf --layer mrt --kinds mrt_station --around hotels --radius 800 --source osm --timeout 120 --force$/);
  assert.match(read('pf', 'map.config.json').layers.find((l) => l.id === 'mrt').partial, /Photon/);
  assert.equal((await uw(['places', 'pf', '--layer', 'cafes', '--kinds', 'cafe', '--around', 'hotels', '--radius', '800'])).code, 0);
  const e = await uw(['enrich', 'pf', '--layer', 'hotels', '--route-to', 'mrt', '--nearest', 'mrt', '--count', 'cafes', '--json']);
  assert.equal(e.code, 0, e.err);
  assert.deepEqual(e.json.partial.map((p) => [p.layer, p.metrics.sort()]), [['mrt', ['nearest_mrt_m', 'walk_min_mrt']]]);
  const m = read('pf', 'data/metrics.json').metrics;
  for (const k of ['walk_min_mrt', 'walk_km_mrt', 'nearest_mrt_m']) {
    assert.equal(m[k].partial, true, k);
    assert.equal(m[k].caveat, 'MRT data partial', k);
    assert.equal(m[k].confidence, 'low', k);
  }
  assert.equal(m.cafes_800m.partial, undefined, 'cafés came from Overpass: complete');
  const q = await uw(QUESTION('pf'));
  assert.equal(q.code, 0, q.err);
  assert.deepEqual(q.json.partial.map((p) => [p.key, p.caveat]), [['walk_min_mrt', 'MRT data partial']]);
  const lines = q.json.verdict.lines;
  assert.ok(lines.some((l) => l.caveats.includes('MRT data partial') && /· MRT data partial$/.test(l.text) && !/⚠/.test(l.text)), JSON.stringify(lines));
  for (const l of lines) assert.doesNotMatch(l.text, /(longest|shortest) walk to the MRT/, l.text);
  assert.match(q.json.verdict.persona, /so far \(MRT data partial\)/);
  const t = await uw(QUESTION('pf').filter((a) => a !== '--json'));
  assert.match(t.out, /PARTIAL DATA: walk_min_mrt → "MRT data partial" on the verdict .*never call an option shortest\/longest on it\. Phase B, first: uw places pf --layer mrt/);
  assert.match(t.out, /Verdict as the map shows it:\n {2}A .*\n {2}B /);
  assert.equal((await uw(['validate', 'pf', '--signal'])).code, 0);
  // Phase B: the complete re-fetch (Overpass back) clears the mark everywhere
  const again = await uw(['places', 'pf', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800', '--force', '--source', 'osm']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /layer "mrt" is complete again/);
  assert.equal(read('pf', 'data/mrt.geojson').uw.partial, undefined);
  assert.equal(read('pf', 'map.config.json').layers.find((l) => l.id === 'mrt').partial, undefined);
  assert.equal((await uw(['enrich', 'pf', '--layer', 'hotels', '--route-to', 'mrt', '--nearest', 'mrt'])).code, 0);
  const m2 = read('pf', 'data/metrics.json').metrics;
  assert.equal(m2.walk_min_mrt.partial, undefined);
  assert.equal(m2.walk_min_mrt.caveat, undefined);
  assert.equal(m2.walk_min_mrt.confidence, 'high');
  const q2 = await uw(QUESTION('pf'));
  assert.deepEqual(q2.json.partial, []);
});

test('an option added after its places step: enrich marks the metric partial (outside the fetched area) and says how to fix it', async () => {
  await site('late', HOTELS.slice(0, 2));
  assert.equal((await uw(['places', 'late', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800'])).code, 0);
  const add = await uw(['add-point', 'late', '--layer', 'hotels', '--query', 'Lore Hotel, Taipei', '--near', NEAR, '--id', 'lore']);
  assert.equal(add.code, 0, add.err);
  const e = await uw(['enrich', 'late', '--layer', 'hotels', '--route-to', 'mrt', '--nearest', 'mrt', '--json']);
  assert.equal(e.code, 0, e.err);
  assert.equal(e.json.partial.length, 1);
  assert.match(e.json.partial[0].reason, /lore is outside the area "mrt" was fetched for/);
  assert.equal(e.json.partial[0].refetch, 'uw places late --layer mrt --kinds mrt_station --around hotels --radius 800 --force');
  assert.equal(read('late', 'data/metrics.json').metrics.walk_min_mrt.partial, true);
  // the fix it names works
  assert.equal((await uw(e.json.partial[0].refetch.split(' ').slice(1))).code, 0);
  const e2 = await uw(['enrich', 'late', '--layer', 'hotels', '--route-to', 'mrt', '--nearest', 'mrt', '--json']);
  assert.deepEqual(e2.json.partial, []);
  assert.equal(hotels('late').lore.walk_min_mrt_name, 'Daqiaotou');
});

test('engine: a partial metric is said as a value with a caveat chip, never "shortest"/"longest"; the chip leaves when complete', async () => {
  const Question = await engine();
  const feats = [['via', 6], ['ever', 8], ['lore', 13]].map(([id, w]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id, name_en: id, walk_min_mrt: w } }));
  const q = { kind: 'choose-one', options: { layer: 'hotels', ids: ['via', 'ever', 'lore'], letters: 'rank' },
    criteria: [{ key: 'walk_min_mrt', weight: 2, phrase: { lead: 'shortest walk to the MRT', value: '{value} walk to the MRT', worst: 'longest walk to the MRT ({value})' } }] };
  const base = { label: 'Walk to MRT', unit: 'min', better: 'lower', basis: 'routed', good: 3, bad: 15, threshold: 2 };
  const mk = (m) => { const E = new Question(q, { metrics: { walk_min_mrt: m }, features: () => feats, percentile: () => null }); E.resolve(); return E; };
  const full = mk(base).verdictLines();
  assert.match(full.find((l) => l.ref === 'hotels:lore').text, /longest walk to the MRT \(13 min\)/, 'complete data may say longest');
  assert.match(full.find((l) => l.ref === 'hotels:via').text, /shortest walk to the MRT/);
  const E = mk({ ...base, partial: true, caveat: 'MRT data partial', partial_reason: 'Photon fallback' });
  const lines = E.verdictLines();
  for (const l of lines) {
    assert.doesNotMatch(l.text, /shortest|longest/, l.text);
    assert.deepEqual(l.caveats, ['MRT data partial']);
    assert.match(l.text, /· MRT data partial$/);
    assert.doesNotMatch(l.text, /⚠/, 'the caveat is words, no warning glyph');
    assert.ok(l.facts.every((f) => f.partial === 'MRT data partial'));
  }
  assert.match(lines.find((l) => l.ref === 'hotels:lore').text, /13 min walk to the MRT/);
  assert.match(E.personaLine().text, /^Best by your weights: A · so far \(MRT data partial\)$/);
  const why = E.why(E.opts.find((o) => o.id === 'lore'));
  assert.doesNotMatch(why.tradeoff || '', /longest|worst of the/);
  assert.match(why.tradeoff || '', /MRT data partial/);
});
