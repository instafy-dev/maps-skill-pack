// "Plan 3 days in Seville for a first visit: where to stay, what to see each day, on a map" got one sight a day. The
// trip guide asked for "2-3 per city", which three sights in one city meet, and `uw validate` only warned about days
// with one place ("until each stop has 2-3"), so the turn replied with almost seven minutes left. Now:
//  - a full day takes 2-3 sourced places: with --sights, a day with one fails `uw validate` as a day with none does,
//    while the turn clock leaves more than about 3 minutes; with less it is a warning, and the reply says it;
//  - the trip guide asks for 2-3 a full day, and a sight cites the venue's own site where the turn found one;
//  - a square the search found is a square: an artwork of its name on it is not the square mapped twice;
//  - a place to stay cites its own record in OpenStreetMap, never OpenStreetMap's licence page.
// Offline: the place search, the lodging search and the walking router are a local mock in this file.
// Run: node --test tests/full-days.test.mjs
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
const { kindLabel } = await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'util.js')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-full-days-'));

// ---------------------------------------------------------------------------
// The place search's answers (OpenStreetMap names, kinds and positions, in the search's answer shape)
const CITY = [-5.99534, 37.38863];
const SANTA_CRUZ = [-5.9905, 37.3855];
const SEV = { city: 'Sevilla', county: 'Sevilla', state: 'Andalucía', country: 'España', countrycode: 'ES' };
const hit = (c, osm, name, more = {}) => {
  const [osm_type, osm_id, osm_key, osm_value] = osm;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osm_type, osm_id, osm_key, osm_value, name, ...SEV, ...more } };
};
const ANSWERS = {
  // the square first; then the pedestrian area of the same name, an artwork of the same name on it, and a fountain
  'Plaza de España, Seville': [
    hit([-5.98694, 37.376974], ['R', 1866166, 'place', 'square'], 'Plaza de España', { district: 'Distrito Sur' }),
    hit([-5.986001, 37.376583], ['W', 40670357, 'highway', 'pedestrian'], 'Plaza de España', { district: 'Distrito Sur' }),
    hit([-5.98565, 37.376903], ['R', 4468922, 'tourism', 'artwork'], 'Plaza de España', { street: 'Calle Diego de Riaño', district: 'Distrito Sur' }),
    hit([-5.986898, 37.377089], ['W', 1269126342, 'amenity', 'fountain'], 'Fuente Plaza de España', { street: 'Plaza de España', district: 'Distrito Sur' }),
  ],
  // a locality only names a spot: the viewpoint there of the same name is the place
  'Mirador de Prueba, Seville': [
    hit([-5.9801, 37.3801], ['N', 9901, 'place', 'locality'], 'Mirador de Prueba', { district: 'Distrito Sur' }),
    hit([-5.98015, 37.38012], ['N', 9902, 'tourism', 'viewpoint'], 'Mirador de Prueba', { district: 'Distrito Sur' }),
  ],
};
const off = (c, dx, dy) => [Math.round((c[0] + dx / 88400) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
// the lodging search's answer: two hotels mapped as points and one as a building (a way, with its centre)
const LODGING = [
  { type: 'node', id: 801, c: off(SANTA_CRUZ, 150, 0), tags: { tourism: 'hotel', name: 'Hotel Patio de la Cruz' } },
  { type: 'node', id: 802, c: off(SANTA_CRUZ, 0, 300), tags: { tourism: 'hotel', name: 'Hotel Judería', website: 'https://hotel-juderia.example/' } },
  { type: 'way', id: 803, c: off(SANTA_CRUZ, 350, -350), tags: { tourism: 'hotel', name: 'Hotel Murallas' } },
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
      const feats = u.searchParams.getAll('osm_tag').length ? [] : ANSWERS[q] || [];
      res.end(JSON.stringify({ type: 'FeatureCollection', features: feats }));
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        const elements = /"tourism"~/.test(q) ? LODGING.filter(near).map((e) => (e.type === 'node'
          ? { type: e.type, id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags }
          : { type: e.type, id: e.id, center: { lon: e.c[0], lat: e.c[1] }, tags: e.tags })) : [];
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
const uw = (args, { input = null, clock = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_NO_CACHE: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  if (clock) Object.assign(env, { INSTAFY_TURN_STARTED_AT: clock.started, INSTAFY_TURN_DEADLINE: clock.deadline });
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features;
/** A host turn of ten minutes with `usedS` seconds used (the pack keeps two minutes of it for the reply). */
const hostClock = (usedS) => ({ started: new Date(Date.now() - usedS * 1000).toISOString(), deadline: new Date(Date.now() + (600 - usedS) * 1000).toISOString() });

// a first visit's sights, each with its own site's page (positions as OpenStreetMap has them)
const SIGHTS = [
  { id: 'cathedral', name: 'Cathedral of Seville', at: [-5.993141, 37.385915], page: 'https://www.catedraldesevilla.es/en/' },
  { id: 'alcazar', name: 'Alcázar of Seville', at: [-5.990183, 37.383211], page: 'https://www.alcazarsevilla.org/en/' },
  { id: 'plaza-espana', name: 'Plaza de España', at: [-5.98694, 37.376974], page: 'https://www.visitasevilla.es/en/plaza-de-espana' },
  { id: 'indies', name: 'General Archive of the Indies', at: [-5.992657, 37.384365], page: 'https://www.cultura.gob.es/archivo-indias/' },
  { id: 'torre-del-oro', name: 'Torre del Oro', at: [-5.99629, 37.38245], page: 'https://armada.defensa.gob.es/torre-del-oro' },
  { id: 'maria-luisa', name: 'María Luisa Park', at: [-5.98809, 37.37511], page: 'https://www.sevilla.org/parque-maria-luisa' },
];
const pin = (site, s) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-', '--json'],
  { input: JSON.stringify({ stop: 'seville', source_url: s.page, source: new URL(s.page).hostname.replace(/^www\./, ''), why: `see ${s.name}` }) });
const newTrip = async (site) => {
  assert.equal((await uw(['new', site, '--title', '3 days in Seville', '--ask', 'Where to stay and what to see', '--center', CITY.join(','), '--zoom', '13', '--expect', 'Seville:3'])).code, 0);
  const stop = await uw(['add-point', site, '--layer', 'stops', '--at', CITY.join(','), '--name', 'Seville', '--kind', 'city', '--id', 'seville', '--props', '{"nights":3}']);
  assert.equal(stop.code, 0, stop.out + stop.err);
};
const plan = (site, more = []) => uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-02', ...more, '--force', '--json']);
const sightsOn = (site) => cfgOf(site).plan.days.map((d) => d.items.filter((it) => it.ref?.layer === 'sights').length);

// ---------------------------------------------------------------------------
test('a 3-day trip with one sight a day fails uw validate with --sights while the turn has time; two a day pass', async () => {
  const site = 'sv';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 3)) assert.equal((await pin(site, s)).code, 0);
  const one = await plan(site, ['--sights', 'sights']);
  assert.equal(one.code, 0, one.out + one.err);
  assert.deepEqual(sightsOn(site), [1, 1, 1], 'one sight a day, the arrival day too');

  // a fresh turn (eight minutes for tool work): a day with one place is not finished
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 1, v.out);
  const days = v.json.errors.filter((e) => e.path === '$.plan.days');
  assert.deepEqual(days.map((e) => e.message), ['3 of 3 full days have one place to see (a full day takes 2-3 sourced places): Mon 2 Nov · Seville, Tue 3 Nov · Seville, Wed 4 Nov · Seville']);
  assert.match(days[0].fix, /^pin one or two more places a page you read names for each of those days, in that day's area \(reference\/itinerary\.md Phase B step 1: uw add-point sv --layer sights … with \{"stop":…,"source_url":…\}, one place per command\), then uw plan sv … --sights sights --force$/);
  assert.equal(v.json.warnings.filter((w) => w.path === '$.plan.days').length, 0, 'an error, not also a warning');
  // the text form names the time left on the clock line, after the error
  const text = await uw(['validate', site, '--signal']);
  assert.equal(text.code, 1);
  assert.match(text.out, /^ERROR map\.config\.json \$\.plan\.days: 3 of 3 full days have one place to see/m);
  assert.match(text.err, /time: 0m\d\ds used, about (7m\d\d|8m00)s left for tool work this turn\. 3 of 3 full days have fewer than 2 sourced sights\./);

  // two a day: each full day has 2 sourced places, and validate passes
  for (const s of SIGHTS.slice(3)) assert.equal((await pin(site, s)).code, 0);
  const two = await plan(site, ['--sights', 'sights']);
  assert.equal(two.code, 0, two.out + two.err);
  assert.deepEqual(sightsOn(site), [2, 2, 2]);
  const ok = await uw(['validate', site, '--signal', '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.json?.errors ?? ok.out, null, 1));
  assert.deepEqual(ok.json.warnings.filter((w) => w.path === '$.plan.days'), []);
});

test('with under ~3 minutes left, a day with one place is a warning that asks for 2-3 each full day; a day with none still fails', async () => {
  const site = 'sv-late';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 3)) assert.equal((await pin(site, s)).code, 0);
  assert.equal((await plan(site, ['--sights', 'sights'])).code, 0);
  // 7 min 30 s of a ten-minute turn used: 30 s left for tool work, time to reply
  const late = await uw(['validate', site, '--signal', '--json'], { clock: hostClock(450) });
  assert.equal(late.code, 0, JSON.stringify(late.json?.errors ?? late.out, null, 1));
  const w = late.json.warnings.filter((x) => x.path === '$.plan.days');
  assert.deepEqual(w.map((x) => x.message), ['3 of 3 full days have fewer than 2 sourced items: one sight a day is not a day worth following']);
  assert.equal(w[0].fix, 'add sights until each full day has 2-3 with a source page (reference/itinerary.md Phase B step 1), then uw plan … --sights sights --force');
  // 2 min 30 s used: five and a half minutes left, so it fails
  const early = await uw(['validate', site, '--signal', '--json'], { clock: hostClock(150) });
  assert.equal(early.code, 1, early.out);
  assert.ok(early.json.errors.some((e) => /^3 of 3 full days have one place to see/.test(e.message)), JSON.stringify(early.json.errors, null, 1));

  // a day with nothing to see fails whatever the time
  const file = path.join(tmp, site, 'data', 'sights.geojson');
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...fc, features: fc.features.slice(0, 2) }));
  assert.equal((await plan(site, ['--sights', 'sights'])).code, 0);
  assert.deepEqual(sightsOn(site), [0, 1, 1]);
  const none = await uw(['validate', site, '--signal', '--json'], { clock: hostClock(450) });
  assert.equal(none.code, 1, none.out);
  assert.deepEqual(none.json.errors.filter((e) => e.path === '$.plan.days').map((e) => e.message), ['1 of 3 full days have nothing to see (no sourced place): Mon 2 Nov · Seville']);
});

test('without --sights, most days with one place is the same warning, and never an error', async () => {
  const site = 'sv-nosights';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 3)) assert.equal((await pin(site, s)).code, 0);
  // the plan places them only when given the layer; without --sights the trip is not about what to see each day
  const p = await plan(site, ['--sights', 'sights']);
  assert.equal(p.code, 0);
  const cfg = cfgOf(site);
  delete cfg.plan.sights;
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.deepEqual(v.json.warnings.filter((x) => x.path === '$.plan.days').map((x) => x.fix),
    ['add sights until each full day has 2-3 with a source page (reference/itinerary.md Phase B step 1), then uw plan … --sights sights --force']);
});

test('a place to stay cites its own record in OpenStreetMap, never the licence page; the base day links it', async () => {
  const site = 'sv-stay';
  await newTrip(site);
  const r = await uw(['stay', site, '--near', SANTA_CRUZ.join(','), '--near-label', 'Santa Cruz', '--stop', 'seville', '--kinds', 'hotel', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const stays = layerOf(site, 'stays');
  assert.equal(stays.length, 3);
  const pages = Object.fromEntries(stays.map((f) => [f.properties.name, f.properties.source_url]));
  assert.deepEqual(pages, {
    'Hotel Patio de la Cruz': 'https://www.openstreetmap.org/node/801',
    'Hotel Judería': 'https://www.openstreetmap.org/node/802',
    'Hotel Murallas': 'https://www.openstreetmap.org/way/803',
  });
  for (const f of stays) {
    assert.equal(f.properties.source, 'OpenStreetMap');
    assert.doesNotMatch(JSON.stringify(f.properties), /openstreetmap\.org\/copyright/);
  }
  assert.equal(stays.find((f) => f.properties.name === 'Hotel Judería').properties.website, 'https://hotel-juderia.example/', 'its own site stays its website');
  // the licence is the map's credit
  assert.ok(cfgOf(site).attribution.includes('© OpenStreetMap contributors (ODbL)'));
  // the plan's base line links the base's own record
  for (const s of SIGHTS) assert.equal((await pin(site, s)).code, 0);
  assert.equal((await plan(site, ['--stays', 'stays', '--sights', 'sights'])).code, 0);
  const first = stays.find((f) => f.properties.rank === 1).properties;
  const base = cfgOf(site).plan.days[0].items.find((it) => /^Base: /.test(it.text));
  assert.match(base.text, new RegExp(`^Base: ${first.name} · \\d+ min walk to Santa Cruz$`));
  assert.deepEqual([base.url, base.source], [first.source_url, 'OpenStreetMap']);
});

test('a square the search found first stays the square: an artwork of its name on it is not the square mapped twice', async () => {
  const site = 'sv-square';
  assert.equal((await uw(['new', site, '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  const sight = (id, q) => uw(['add-point', site, '--layer', 'sights', '--query', q, '--country', 'ES', '--strict-name', '--near', CITY.join(','), '--id', id, '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'seville', source_url: 'https://www.visitasevilla.es/en/', source: 'visitasevilla.es' }) });
  const r = await sight('plaza-espana', 'Plaza de España, Seville');
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual([r.json.chosen.type, r.json.chosen.osm_id], ['place=square', 'osm-r1866166']);
  const f = layerOf(site, 'sights').find((x) => x.properties.id === 'plaza-espana');
  assert.equal(f.properties.kind, 'square');
  assert.equal(kindLabel(f.properties.kind), 'Square', 'the card says what it is');
  // a locality only names a spot: the viewpoint there is the place, as before
  const m = await sight('mirador', 'Mirador de Prueba, Seville');
  assert.equal(m.code, 0, m.out + m.err);
  assert.equal(m.json.chosen.type, 'tourism=viewpoint');
});

test('the trip guide asks for 2-3 sourced places a full day, not a city, and says when uw validate fails on one', () => {
  const md = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(md, / 1\. \*\*Sights with sources, 2-3 a full day\.\*\* /);
  assert.match(md, /`uw validate` fails while a full day has fewer than two sourced places \(one: while the turn clock shows more than ~3 min left\)/);
  assert.match(md, /Every full day gets its places before the reply: `uw validate` fails while one has fewer than two\./);
  // no line of the pack asks for 2-3 a city or a stop any more: three sights in one city are one a day for three days
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const said = walk(SKILL).filter((f) => /\.(md|mjs|json)$/.test(f))
    .filter((f) => /2-3 (per|a|each) (city|stop)|each stop has 2-3|2-3 sourced sights per stop/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(said.map((f) => path.relative(SKILL, f)), []);
});
