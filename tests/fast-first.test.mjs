// Fast-first: network commands have time limits (--timeout, per-command defaults, the turn budget) and are SKIPPED
// (exit 4, one "skipped: …" line) instead of hanging; partial output stays valid; the config is never broken; and
// `uw question` gives a real verdict from Phase-A metrics only (MRT walk, café counts), later steps refine it.
// Offline: Photon / Overpass / OSRM / Valhalla are a local mock (fixtures.mjs) with /hang/ and /busy/ paths.
// Run: node --test map-pack/tests/*.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeRegistryCache, startMock, VIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-fast-'));
const cache = path.join(tmp, 'cache');
let mock;
const baseEnv = () => ({ ...process.env, UW_CACHE: cache, UW_PHOTON: mock.url, UW_OVERPASS: mock.url + '/api/interpreter', UW_OSRM: mock.url,
  UW_VALHALLA: mock.url, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0' });
const run = (args, env = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...baseEnv(), ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 60000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err, ms: Date.now() - t0 }); });
});
const uw = async (args, env) => {
  const r = await run(args, env);
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.out); } catch {} }
  return { ...r, json };
};
const file = (site, rel) => path.join(tmp, site, rel);
const cfgText = (site) => fs.readFileSync(file(site, 'map.config.json'), 'utf8');
const cfgOf = (site) => JSON.parse(cfgText(site));
const hotels = (site) => Object.fromEntries(JSON.parse(fs.readFileSync(file(site, 'data/hotels.geojson'), 'utf8')).features.map((f) => [f.properties.id, f.properties]));
const NEAR = VIA.join(',');

// the three-hotel Taipei map up to Phase A's places (MRT stations + cafés), as in the Instafy run
async function phaseA(site) {
  assert.equal((await uw(['new', site, '--title', 'Taipei: which hotel?', '--center', NEAR, '--zoom', '14'])).code, 0);
  for (const [q, id] of [['Via Hotel Loft, Taipei', 'via-loft'], ['Everstar Hotel, Taipei', 'everstar'], ['Lore Hotel, Taipei', 'lore']]) {
    const r = await uw(['add-point', site, '--layer', 'hotels', '--query', q, '--near', NEAR, '--id', id]);
    assert.equal(r.code, 0, r.err);
  }
  const m = await uw(['places', site, '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800']);
  assert.equal(m.code, 0, m.err);
  const c = await uw(['places', site, '--layer', 'cafes', '--kinds', 'cafe', '--around', 'hotels', '--radius', '800']);
  assert.equal(c.code, 0, c.err);
}
const QUESTION = (site) => ['question', site, '--kind', 'choose-one', '--options', 'hotels', '--criteria', 'quiet_night_blocks:3,walk_min_mrt:2,cafes:1',
  '--lenses', 'sleep,night,move', '--lens', 'sleep', '--ask', 'Which hotel for 3 nights?', '--force', '--json'];

before(async () => { await writeRegistryCache(cache); mock = await startMock(); });
after(() => { mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
test('Phase A only: enrich + question give lettered options and a verdict; pending criteria and lenses are listed', async () => {
  await phaseA('fa');
  const e = await uw(['enrich', 'fa', '--layer', 'hotels', '--count', 'cafes', '--nearest', 'mrt', '--route-to', 'mrt']);
  assert.equal(e.code, 0, e.err);
  const h = hotels('fa');
  for (const id of ['via-loft', 'everstar', 'lore']) {
    assert.equal(typeof h[id].walk_min_mrt, 'number', `${id} walk_min_mrt`);
    assert.equal(typeof h[id].cafes_800m, 'number', `${id} cafes_800m`);
  }
  const q = await uw(QUESTION('fa'));
  assert.equal(q.code, 0, q.err);
  const Q = q.json.question;
  assert.deepEqual(Q.criteria.map((c) => [c.key, c.weight]), [['walk_min_mrt', 2], ['cafes_800m', 1]], '"cafes" resolved to the count that exists');
  assert.deepEqual(q.json.pending.map((p) => p.key), ['quiet_night_blocks']);
  assert.match(q.json.pending[0].made_by, /uw feel \+ uw areas/);
  assert.deepEqual(Q.lenses.map((l) => l.id), ['move'], 'sleep/night have nothing to rank yet: left out');
  assert.deepEqual(q.json.pending_lenses.map((l) => l.id), ['sleep', 'night']);
  assert.equal(Q.lens, undefined, 'the pending starting lens falls back to your own weights');
  assert.equal(Q.lenses[0].persona, undefined, 'a lone persona is dropped (the persona line needs two)');
  assert.equal(Q.options.ids.length, 3);
  assert.equal(q.json.ranking[0].id, Q.options.ids[0], 'A = the best match');
  assert.match(Q.criteria[1].phrase.value, /^\{n\} cafés nearby$/);
  assert.equal(Q.criteria[1].label, "Cafés within 800 m");
  // the engine writes the verdict from these numbers: one line per option, with a number and no "undefined"
  const { Question } = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'question.js')).href);
  const feats = JSON.parse(fs.readFileSync(file('fa', 'data/hotels.geojson'), 'utf8')).features;
  const metrics = JSON.parse(fs.readFileSync(file('fa', 'data/metrics.json'), 'utf8')).metrics;
  const E = new Question(Q, { metrics, features: () => feats, percentile: () => null });
  E.resolve();
  const lines = E.verdictLines();
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.letter), ['A', 'B', 'C']);
  for (const l of lines) {
    assert.ok(l.cites.length, `${l.text} cites a metric`);
    assert.doesNotMatch(l.text, /undefined|NaN|null/);
  }
  assert.match(lines[0].text, /walk to the MRT|cafés/, lines[0].text);
  assert.match(E.personaLine().text, /^Best by your weights: A/);
  const v = await uw(['validate', 'fa']);
  assert.equal(v.code, 0, v.out + v.err);
});

test('question with nothing measured yet is skipped (exit 4) and says what to run', async () => {
  assert.equal((await uw(['new', 'bare', '--title', 't', '--center', NEAR, '--zoom', '14'])).code, 0);
  assert.equal((await uw(['add-point', 'bare', '--layer', 'hotels', '--query', 'Via Hotel Loft, Taipei', '--near', NEAR, '--id', 'via-loft'])).code, 0);
  assert.equal((await uw(['add-point', 'bare', '--layer', 'hotels', '--query', 'Lore Hotel, Taipei', '--near', NEAR, '--id', 'lore'])).code, 0);
  const before = cfgText('bare');
  const q = await uw(['question', 'bare', '--options', 'hotels', '--criteria', 'walk_min_mrt:2,cafes:1']);
  assert.equal(q.code, 4, q.err);
  assert.match(q.err, /^skipped: question: no hotels option has walk_min_mrt, cafes yet.*uw enrich --layer hotels --route-to mrt/m);
  assert.equal(cfgText('bare'), before, 'config untouched');
});

test('places: a hanging Overpass is skipped at --timeout with one clear line; config and files untouched', async () => {
  const before = cfgText('fa');
  const r = await uw(['places', 'fa', '--layer', 'gyms', '--kinds', 'gym', '--around', 'hotels', '--radius', '600', '--timeout', '3'],
    { UW_OVERPASS: mock.url + '/hang/api/interpreter' });
  assert.equal(r.code, 4, r.err);
  assert.ok(r.ms < 15000, `took ${r.ms} ms`);
  const lines = r.err.trim().split('\n').filter((l) => /^skipped:/.test(l));
  assert.equal(lines.length, 1, r.err);
  assert.match(lines[0], /^skipped: Overpass too slow after \d+ s; the map works without it; retry later with: uw places fa --layer gyms --kinds gym --around hotels --radius 600 --timeout 120$/);
  assert.equal(cfgText('fa'), before);
  assert.ok(!fs.existsSync(file('fa', 'data/gyms.geojson')));
  const j = await uw(['places', 'fa', '--layer', 'gyms', '--kinds', 'gym', '--around', 'hotels', '--timeout', '2', '--json'], { UW_OVERPASS: mock.url + '/hang/api/interpreter' });
  assert.equal(j.code, 4);
  assert.equal(j.json.skipped, true);
  assert.equal(j.json.exit_code, 4);
});

test('feel: a busy Overpass (504) is skipped, nothing written; the turn budget skips slow steps at once', async () => {
  const before = cfgText('fa');
  const r = await uw(['feel', 'fa', '--around', 'hotels', '--timeout', '6'], { UW_OVERPASS: mock.url + '/busy/api/interpreter' });
  assert.equal(r.code, 4, r.err);
  assert.match(r.err, /^skipped: Overpass busy after \d+ s.*; the map works without it; retry later with: uw feel fa --around hotels --timeout 120$/m);
  assert.ok(!fs.existsSync(file('fa', 'data/feel.geojson')));
  assert.equal(cfgText('fa'), before);
  // 8 min into a turn (budget 1 s here): feel is not even started; Phase-A commands still run
  const b = await uw(['feel', 'fa', '--around', 'hotels'], { UW_TURN_BUDGET: '1' });
  assert.equal(b.code, 4);
  assert.match(b.err, /^skipped: \dm\d\ds of this turn are used .*Validate, serve and reply now, then offer this as a follow-up: uw feel fa --around hotels --timeout \d+/m);
  assert.ok(b.ms < 5000);
  const p = await uw(['places', 'fa', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800', '--force'], { UW_TURN_BUDGET: '1' });
  assert.equal(p.code, 0, p.err);
  const v = await uw(['validate', 'fa']);
  assert.equal(v.code, 0, v.out + v.err);
});

test('enrich: OSRM hangs after 2 routes → partial metrics are written (exit 4, "kept …"), question still works', async () => {
  await phaseA('pa');
  mock.resetOsrm();
  const r = await uw(['enrich', 'pa', '--layer', 'hotels', '--count', 'cafes', '--nearest', 'mrt', '--route-to', 'mrt', '--timeout', '4'],
    { UW_OSRM: mock.url + '/osrmhang2' });
  assert.equal(r.code, 4, r.err);
  assert.match(r.err, /^skipped: OSRM routing .* too slow after \d+ s.*; kept .*cafes_800m.* in hotels \(walk_min_mrt missing for 1 of 3 \(nearest_mrt_m, straight line, stands in\)\); the map works without it; retry later with: uw enrich pa /m);
  const h = Object.values(hotels('pa'));
  assert.equal(h.filter((p) => typeof p.walk_min_mrt === 'number').length, 2);
  assert.ok(h.every((p) => typeof p.cafes_800m === 'number' && typeof p.nearest_mrt_m === 'number'));
  assert.ok(JSON.parse(fs.readFileSync(file('pa', 'data/metrics.json'), 'utf8')).metrics.walk_min_mrt, 'metrics.json written');
  const q = await uw(QUESTION('pa'));
  assert.equal(q.code, 0, q.err);
  assert.ok(q.json.warnings.some((w) => /walk_min_mrt" is missing on 1/.test(w)));
  assert.equal((await uw(['validate', 'pa'])).code, 0);
});

test('isochrone: Valhalla hangs → skipped, no walk layer registered', async () => {
  const before = cfgText('pa');
  const r = await uw(['isochrone', 'pa', '--layer', 'walk', '--from', 'layer:hotels', '--minutes', '10', '--timeout', '3'], { UW_VALHALLA: mock.url + '/hang' });
  assert.equal(r.code, 4, r.err);
  assert.match(r.err, /^skipped: Valhalla .* too slow after \d+ s/m);
  assert.equal(cfgText('pa'), before);
});

test('feel --around points: only cells near the options; then question refines with more lenses', async () => {
  const r = await uw(['feel', 'pa', '--around', 'hotels', '--json']);
  assert.equal(r.code, 0, r.err);
  const meta = JSON.parse(fs.readFileSync(file('pa', 'data/feel.meta.json'), 'utf8'));
  assert.equal(meta.around.radius_m, 700);
  assert.equal(meta.around.points, 3);
  assert.ok(meta.cells < meta.grid[0] * meta.grid[1], `${meta.cells} of ${meta.grid[0] * meta.grid[1]} cells`);
  const pts = Object.values(JSON.parse(fs.readFileSync(file('pa', 'data/hotels.geojson'), 'utf8')).features).map((f) => f.geometry.coordinates);
  const grid = JSON.parse(fs.readFileSync(file('pa', 'data/feel.geojson'), 'utf8')).features;
  const d = (a, b) => Math.hypot((a[0] - b[0]) * 101000, (a[1] - b[1]) * 111000);
  for (const c of grid) {
    const ring = c.geometry.coordinates[0];
    const mid = [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2];
    assert.ok(pts.some((p) => d(p, mid) <= 700 + 160), `${c.properties.id} is near an option`);
  }
  const e = await uw(['enrich', 'pa', '--layer', 'hotels', '--feel']);
  assert.equal(e.code, 0, e.err);
  const q = await uw(QUESTION('pa'));
  assert.equal(q.code, 0, q.err);
  assert.ok(q.json.question.lenses.some((l) => l.id === 'sleep'), 'sleep can rank now (calm_night at the door)');
  assert.equal(q.json.question.lens, 'sleep');
  assert.equal((await uw(['validate', 'pa'])).code, 0);
});

test('Overpass: a hanging mirror gets only part of the time; the next server answers; later runs try it last', async () => {
  const both = { UW_OVERPASS: `${mock.url}/hang/x/interpreter,${mock.url}/api/interpreter` };
  // (--timeout 40: places keeps 15 s of it back for the Photon fallback, so Overpass has ~25 s)
  const a = await uw(['places', 'pa', '--layer', 'mrt2', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800', '--timeout', '40', '--source', 'osm'], both);
  assert.equal(a.code, 0, a.err);
  assert.ok(a.ms > 10000 && a.ms < 20000, `first run waited part of the budget on the hung mirror (${a.ms} ms)`);
  assert.match(fs.readFileSync(file('pa', 'data/mrt2.geojson'), 'utf8'), /Shuanglian/);
  const b = await uw(['places', 'pa', '--layer', 'mrt2', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800', '--timeout', '40', '--force', '--source', 'osm'], both);
  assert.equal(b.code, 0, b.err);
  assert.ok(b.ms < 6000, `the hung mirror is tried last now (${b.ms} ms)`);
});

test('enrich measures what exists when a places step was skipped; with nothing to measure it is skipped (exit 4)', async () => {
  await phaseA('miss');
  // as if its places step had been skipped: no file, not registered
  fs.rmSync(file('miss', 'data/mrt.geojson'));
  const cfg = cfgOf('miss'); cfg.layers = cfg.layers.filter((l) => l.id !== 'mrt');
  fs.writeFileSync(file('miss', 'map.config.json'), JSON.stringify(cfg, null, 2));
  const r = await uw(['enrich', 'miss', '--layer', 'hotels', '--route-to', 'mrt', '--nearest', 'mrt', '--count', 'cafes']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /layer "mrt" has no data yet/);
  assert.ok(Object.values(hotels('miss')).every((p) => typeof p.cafes_800m === 'number' && p.walk_min_mrt === undefined));
  const q = await uw(QUESTION('miss'));
  assert.equal(q.code, 0, q.err);
  assert.deepEqual(q.json.question.criteria.map((c) => c.key), ['cafes_800m']);
  assert.deepEqual(q.json.pending.map((p) => p.key), ['quiet_night_blocks', 'walk_min_mrt']);
  const n = await uw(['enrich', 'miss', '--layer', 'hotels', '--route-to', 'mrt']);
  assert.equal(n.code, 4);
  assert.match(n.err, /^skipped: enrich: "mrt" has no data yet/m);
  // steps that need a skipped step's output are skipped too, with what to run first
  const f = await uw(['enrich', 'miss', '--layer', 'hotels', '--feel']);
  assert.equal(f.code, 4);
  assert.match(f.err, /^skipped: enrich: no feel grid yet .*uw feel miss --around hotels/m);
  const a = await uw(['areas', 'miss', '--lens', 'quiet_night', '--within', 'walk', '--options', 'hotels']);
  assert.equal(a.code, 4);
  assert.match(a.err, /^skipped: areas: no feel grid/m);
  assert.equal((await uw(['validate', 'miss'])).code, 0);
});

test('question: a criterion every option ties on stays visible ("always") instead of failing validate', async () => {
  const p = file('miss', 'data/hotels.geojson');
  const fc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const vals = { 'via-loft': [117, 6], everstar: [117, 8], lore: [34, 3] };
  for (const f of fc.features) [f.properties.cafes_800m, f.properties.walk_min_mrt] = vals[f.properties.id];
  fs.writeFileSync(p, JSON.stringify(fc));
  const m = JSON.parse(fs.readFileSync(file('miss', 'data/metrics.json'), 'utf8'));
  m.metrics.walk_min_mrt = { label: 'Walk to MRT', unit: 'min', format: 'int', better: 'lower', basis: 'routed', confidence: 'high', source: 'OSRM', good: 3, bad: 15, threshold: 2 };
  fs.writeFileSync(file('miss', 'data/metrics.json'), JSON.stringify(m));
  const q = await uw(QUESTION('miss'));
  assert.equal(q.code, 0, q.err);
  const cafes = q.json.question.criteria.find((c) => c.key === 'cafes_800m');
  assert.equal(cafes.always, true);
  assert.equal(cafes.good, undefined, 'counts past "plenty" keep the 20+ anchor');
  assert.match(q.json.ties[0], /cafes_800m \(117 \/ 117 \/ 34, all 20\+\)/);
  assert.deepEqual(q.json.ranking.map((r) => r.id), ['lore', 'via-loft', 'everstar'], 'the walk decides');
  const v = await uw(['validate', 'miss', '--signal']);
  assert.equal(v.code, 0, v.out + v.err);
  assert.equal((await uw(['places', 'miss', '--layer', 'x', '--kinds', 'cafe', '--timeout', 'soon'])).code, 2);
});

test('add-point: a hanging Photon is skipped and the place is listed as "Not found yet"', async () => {
  assert.equal((await uw(['new', 'ams', '--title', 't', '--center', '4.8897,52.3740', '--zoom', '14'])).code, 0);
  const r = await uw(['add-point', 'ams', '--layer', 'hotels', '--query', 'Hotel V Nesplein, Amsterdam', '--near', '4.8897,52.3740', '--id', 'v', '--timeout', '3'],
    { UW_PHOTON: mock.url + '/hang' });
  assert.equal(r.code, 4, r.err);
  assert.match(r.err, /^skipped: OpenStreetMap search \(Photon\) too slow after \d+ s; kept "Hotel V Nesplein" listed as "Not found yet" on the map; the map works without it; retry later with: uw add-point ams /m);
  const miss = cfgOf('ams').missing;
  assert.equal(miss[0].id, 'v');
  assert.ok(miss[0].tried.some((t) => /busy: skipped/.test(t)));
  assert.equal((await uw(['validate', 'ams'])).code, 0);
});

test('places: Overpass busy → stations and cafés come from Photon; the verdict is real (not a tie)', async () => {
  assert.equal((await uw(['new', 'fb', '--title', 'Taipei: which hotel?', '--center', NEAR, '--zoom', '14'])).code, 0);
  for (const [q, id] of [['Via Hotel Loft, Taipei', 'via-loft'], ['Everstar Hotel, Taipei', 'everstar'], ['Lore Hotel, Taipei', 'lore']])
    assert.equal((await uw(['add-point', 'fb', '--layer', 'hotels', '--query', q, '--near', NEAR, '--id', id])).code, 0);
  const busy = { UW_OVERPASS: mock.url + '/busy/api/interpreter' };
  const m = await uw(['places', 'fb', '--layer', 'mrt', '--kinds', 'mrt_station', '--around', 'hotels', '--radius', '800', '--timeout', '20', '--source', 'osm'], busy);
  assert.equal(m.code, 0, m.err);
  assert.ok(m.ms < 15000, `${m.ms} ms`);
  assert.match(m.err, /Overpass .*busy.*; OpenStreetMap search \(Photon\) answered instead .*cannot tell metro from train stations/);
  assert.match(m.out, /From OpenStreetMap search \(Photon\) because Overpass could not answer\..*re-run later: uw places fb --layer mrt --kinds mrt_station --around hotels --radius 800 --source osm --timeout 120/);
  const mrt = JSON.parse(fs.readFileSync(file('fb', 'data/mrt.geojson'), 'utf8'));
  assert.deepEqual(mrt.features.map((f) => f.properties.name).sort(), ['中山', '雙連']);
  assert.ok(mrt.features.every((f) => f.properties.kind === 'mrt_station' && f.properties.source === 'OpenStreetMap search (Photon)'));
  assert.equal(mrt.uw.args.via, 'photon-reverse', 'the provider that answered, as declared in lookup-providers.json');
  const c = await uw(['places', 'fb', '--layer', 'cafes', '--kinds', 'cafe', '--around', 'hotels', '--radius', '800', '--timeout', '20'], busy);
  assert.equal(c.code, 0, c.err);
  // no Photon tag for gyms: still skipped (exit 4)
  const g = await uw(['places', 'fb', '--layer', 'gyms', '--kinds', 'gym', '--around', 'hotels', '--timeout', '10'], busy);
  assert.equal(g.code, 4, g.err);
  assert.equal((await uw(['enrich', 'fb', '--layer', 'hotels', '--route-to', 'mrt', '--nearest', 'mrt', '--count', 'cafes'])).code, 0);
  const q = await uw(QUESTION('fb'));
  assert.equal(q.code, 0, q.err);
  assert.equal(q.json.tied_all, false);
  assert.ok(q.json.question.criteria.some((c) => c.key === 'walk_min_mrt'));
  assert.equal((await uw(['validate', 'fb', '--signal'])).code, 0);
});

test('question: when nothing measured separates the options it says so; the engine never names a "best"', async () => {
  const p = file('miss', 'data/hotels.geojson');
  const fc = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const f of fc.features) [f.properties.cafes_800m, f.properties.walk_min_mrt] = [f.properties.id === 'lore' ? 34 : 117, 6];
  fs.writeFileSync(p, JSON.stringify(fc));
  const q = await uw(QUESTION('miss'));
  assert.equal(q.code, 0, q.err);
  assert.equal(q.json.tied_all, true);
  const t = await uw(QUESTION('miss').filter((a) => a !== '--json'));
  assert.match(t.out, /NOTHING MEASURED YET SEPARATES THE OPTIONS: the letters are the order given, not a pick/);
  const { Question } = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'question.js')).href);
  const metrics = JSON.parse(fs.readFileSync(file('miss', 'data/metrics.json'), 'utf8')).metrics;
  const E = new Question(q.json.question, { metrics, features: () => fc.features, percentile: () => null });
  E.resolve();
  assert.equal(E.personaLine().text, 'Too close to call on what is measured so far');
  assert.equal((await uw(['validate', 'miss'])).code, 0);
});
