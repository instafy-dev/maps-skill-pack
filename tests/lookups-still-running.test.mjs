// A "Plan 3 days in Seville for a first visit: where to stay, what to see each day, on a map" run (31 Oct 2026) pinned
// one sight in three days, and its reply said the run had ended with six minutes left. Two things kept its sights off
// the map:
//  - It looked up four sights in one command. Its command tool stopped waiting after 30 s and answered with a session
//    and no exit code, which the turn did not print, so it planned the days and replied while the lookups ran on.
//    `uw plan` and `uw validate` now name the uw commands still running on the site: what they find is not on the map
//    yet.
//  - The place search had each sight as its first hit in range, and three were refused as not matching their own names,
//    so the map listed them as "Not found yet": "Real Alcázar de Sevilla" (the search also found streets in Alcázar de
//    San Juan, Ciudad Real, which made "Real" and "Alcázar" read as words of the area), "Plaza de España, Seville"
//    ("plaza" a generic word, "España" the country) and "Triana, Seville" (the district the other hits lie in). The
//    words of the area now come from the hits in range, and a hit whose own name is the query's name is a match.
// The search's answers for those three queries are the live search's own (31 Oct 2026). With them, the run's flow (one
// lookup per command, one of them slow) gives each full day 2 or 3 sights cited from their own pages, and "Not found
// yet" lists only the place the search did not find. Also: the trip guide no longer says to reply "with time to
// spare", the one stop of days in one place is not a group in the places list, and a place of worship has the neutral
// sign, not a shrine gate.
// Offline: the place search, the lodging search and the walking router are a local mock in this file.
// Run: node --test tests/lookups-still-running.test.mjs
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
const { stillRunning, runningList, commandLabel } = await lib('running.mjs');
const { nameMatches, nameMatchFor, areaWordsOf } = await lib('cmd-geocode.mjs');
const { emojiFor } = await lib('kinds.mjs');
const { haversine } = await lib('util.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-running-'));

// ---------------------------------------------------------------------------
// The place search, as it answered (OpenStreetMap names, kinds and positions; the local-language answer, and English
// names for the same objects with lang=en)
const CITY = [-5.99534, 37.38863];
const SANTA_CRUZ = [-5.9905, 37.3855];
const SEV = { city: 'Sevilla', county: 'Sevilla', state: 'Andalucía', country: 'España', countrycode: 'ES' };
const hit = (c, osm, name, more = {}) => {
  const [osm_type, osm_id, osm_key, osm_value] = osm;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osm_type, osm_id, osm_key, osm_value, name, ...SEV, ...more } };
};
const ANSWERS = {
  // the run's own queries, the live search's answers on 31 Oct 2026
  'Real Alcázar de Sevilla': [
    hit([-5.990183, 37.38321], ['W', 22747187, 'historic', 'castle'], 'Real Alcázar de Sevilla', { street: 'Patio de Banderas', district: 'Casco Antiguo', locality: 'Santa Cruz' }),
    hit([-5.992174, 37.384412], ['W', 444102193, 'historic', 'city_gate'], 'Puerta del León', { street: 'Patio de Los Leones', district: 'Casco Antiguo', locality: 'Santa Cruz' }),
    hit([-5.991594, 37.384426], ['N', 5619253122, 'tourism', 'attraction'], 'Patronato del Real Alcazar', { street: 'Patio de Banderas', district: 'Casco Antiguo', locality: 'Santa Cruz' }),
    hit([-3.762164, 40.364804], ['W', 31815229, 'highway', 'residential'], 'Calle Real Alcázar de Sevilla', { district: 'Carabanchel', locality: 'Buenavista', city: 'Madrid', county: undefined, state: 'Comunidad de Madrid' }),
    hit([-3.208048, 39.417573], ['W', 267381278, 'waterway', 'stream'], 'Arroyo del Pozo de Sevilla', { city: 'Alcázar de San Juan', county: 'Ciudad Real', state: 'Castilla-La Mancha' }),
    hit([-3.230936, 39.384814], ['W', 85652400, 'highway', 'residential'], 'Calle Arroyo Pozo de Sevilla', { city: 'Alcázar de San Juan', county: 'Ciudad Real', state: 'Castilla-La Mancha' }),
  ],
  'Plaza de España, Seville': [
    hit([-5.98694, 37.376974], ['R', 1866166, 'place', 'square'], 'Plaza de España', { district: 'Distrito Sur' }),
    hit([-5.986001, 37.376583], ['W', 40670357, 'highway', 'pedestrian'], 'Plaza de España', { district: 'Distrito Sur', locality: 'El Prado-Parque de María Luisa' }),
    hit([-5.98565, 37.376903], ['R', 4468922, 'tourism', 'artwork'], 'Plaza de España', { street: 'Calle Diego de Riaño', district: 'Distrito Sur', locality: 'El Prado-Parque de María Luisa' }),
    hit([-5.986898, 37.377089], ['W', 1269126342, 'amenity', 'fountain'], 'Fuente Plaza de España', { street: 'Plaza de España', district: 'Distrito Sur', locality: 'El Prado-Parque de María Luisa' }),
  ],
  'Triana, Seville': [
    hit([-6.004067, 37.383452], ['R', 4680655, 'place', 'suburb'], 'Triana'),
    hit([-6.002431, 37.386278], ['W', 236420470, 'man_made', 'bridge'], 'Puente de Isabel II', { street: 'Calle San Jacinto', district: 'Triana', locality: 'Triana Casco Antiguo' }),
    hit([-6.004647, 37.385548], ['N', 4878565237, 'tourism', 'museum'], 'Centro Cerámica Triana', { district: 'Triana', locality: 'Triana Casco Antiguo' }),
    hit([-6.00355, 37.38575], ['W', 696646033, 'amenity', 'marketplace'], 'Mercado de Triana', { street: 'Calle San Jacinto', district: 'Triana', locality: 'Triana Casco Antiguo' }),
    hit([-6.003713, 37.384806], ['R', 15541929, 'place', 'neighbourhood'], 'Triana Casco Antiguo', { district: 'Triana' }),
  ],
  'Seville Cathedral': [hit([-5.993141, 37.385915], ['R', 5641600, 'amenity', 'place_of_worship'], 'Catedral de Sevilla', { street: 'Plaza Virgen de los Reyes', district: 'Casco Antiguo' })],
  // the rest of a first visit, each under its own name
  'Casa de Pilatos': [hit([-5.987249, 37.390239], ['W', 7101, 'tourism', 'museum'], 'Casa de Pilatos', { district: 'Casco Antiguo' })],
  'Museo de Bellas Artes de Sevilla': [hit([-5.99952, 37.39291], ['W', 7102, 'tourism', 'museum'], 'Museo de Bellas Artes de Sevilla', { district: 'Casco Antiguo' })],
  'Torre del Oro': [hit([-5.99629, 37.38245], ['W', 7103, 'historic', 'tower'], 'Torre del Oro', { district: 'Casco Antiguo' })],
  // a place the search does not know: the one "Not found yet"
  'Casa de la Memoria': [],
  // the stop and the area to stay in
  Seville: [hit(CITY, ['R', 342563, 'place', 'city'], 'Sevilla')],
  'Santa Cruz, Seville': [hit(SANTA_CRUZ, ['R', 4649140, 'place', 'neighbourhood'], 'Santa Cruz', { district: 'Casco Antiguo' })],
};
// "Royal Alcázar of Seville" (the run's sight under another name) finds the same hits, Alcázar de San Juan's too
ANSWERS['Royal Alcázar of Seville'] = ANSWERS['Real Alcázar de Sevilla'];
const EN = { Sevilla: 'Seville', 'Andalucía': 'Andalusia', 'España': 'Spain', 'Castilla-La Mancha': 'Castile-La Mancha', 'Comunidad de Madrid': 'Community of Madrid',
  'Real Alcázar de Sevilla': 'Alcázar of Seville', 'Catedral de Sevilla': 'Cathedral of Seville', 'Museo de Bellas Artes de Sevilla': 'Museum of Fine Arts of Seville' };
const english = (f) => ({ ...f, properties: Object.fromEntries(Object.entries(f.properties).map(([k, v]) => [k, EN[v] ?? v])) });

// each sight's own page, as the run cited them (a city page only says which places are worth it)
const SIGHTS = [
  { id: 'alcazar', q: 'Real Alcázar de Sevilla', page: 'https://en.wikipedia.org/wiki/Alc%C3%A1zar_of_Seville', why: 'the royal palace and its gardens' },
  { id: 'cathedral', q: 'Seville Cathedral', page: 'https://www.catedraldesevilla.es/en/', why: 'the Gothic cathedral and the Giralda' },
  { id: 'plaza-espana', q: 'Plaza de España, Seville', page: 'https://en.wikipedia.org/wiki/Plaza_de_Espa%C3%B1a,_Seville', why: 'the 1929 square in María Luisa Park' },
  { id: 'triana', q: 'Triana, Seville', page: 'https://en.wikipedia.org/wiki/Triana,_Seville', why: 'the west-bank quarter of potters' },
  { id: 'bellas-artes', q: 'Museo de Bellas Artes de Sevilla', page: 'https://en.wikipedia.org/wiki/Museum_of_Fine_Arts_of_Seville', why: 'Murillo and Zurbarán in a convent' },
  { id: 'torre-del-oro', q: 'Torre del Oro', page: 'https://en.wikipedia.org/wiki/Torre_del_Oro', why: 'the 13th-century watchtower on the river' },
];
const SLOW = { id: 'pilatos', q: 'Casa de Pilatos', page: 'https://en.wikipedia.org/wiki/Casa_de_Pilatos', why: 'Andalusian palace with tiled patios' };
const MISSED = { id: 'memoria', q: 'Casa de la Memoria', page: 'https://www.casadelamemoria.es/', why: 'flamenco in a palace courtyard' };

const off = (c, dx, dy) => [Math.round((c[0] + dx / 88400) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const LODGING = [
  { type: 'node', id: 801, c: off(SANTA_CRUZ, 150, 0), tags: { tourism: 'hotel', name: 'Hotel Patio de la Cruz' } },
  { type: 'node', id: 802, c: off(SANTA_CRUZ, 0, 300), tags: { tourism: 'hotel', name: 'Hotel Judería' } },
  { type: 'node', id: 803, c: off(SANTA_CRUZ, 350, -350), tags: { tourism: 'hotel', name: 'Hotel Murallas' } },
];

// one query's answer can be held back: its lookup is still running until the test lets it answer
const held = { query: SLOW.q, released: false, pending: [], arrived: null, arrive: null };
held.arrived = new Promise((r) => { held.arrive = r; });

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
      const q = u.searchParams.get('q') || '', en = u.searchParams.get('lang') === 'en';
      // a type search (osm_tag filters) finds nothing more: the name search is the one that answers
      const feats = u.searchParams.getAll('osm_tag').length ? [] : (ANSWERS[q] || []).map((f) => (en ? english(f) : f));
      const body = JSON.stringify({ type: 'FeatureCollection', features: feats.map((f) => ({ ...f, properties: Object.fromEntries(Object.entries(f.properties).filter(([, v]) => v !== undefined)) })) });
      if (q === held.query && !en && !held.released) { held.pending.push(() => res.end(body)); held.arrive(); return; }
      res.end(body);
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        const elements = /"tourism"~/.test(q) ? LODGING.filter(near).map((e) => ({ type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags })) : [];
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
  held.released = true; for (const f of held.pending.splice(0)) f();
  mock?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const uw = (args, { input = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'UW_RUN_ID']) delete env[k];
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features;
// reference/itinerary.md Phase B step 1: each sight in a command of its own, with its own page
const addSight = (site, s) => uw(['add-point', site, '--layer', 'sights', '--query', s.q, '--country', 'Spain', '--strict-name', '--near', CITY.join(','), '--id', s.id, '--props-file', '-', '--json'],
  { input: JSON.stringify({ stop: 'seville', source_url: s.page, source: new URL(s.page).hostname, why: s.why }) });
const PLAN = ['--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-10-31', '--stays', 'stays', '--sights', 'sights'];

// ---------------------------------------------------------------------------
test('the run\'s own sights, one lookup per command and one slow: plan and validate name it while it runs; then each full day has 2 or 3 sights cited from their own pages, and "Not found yet" lists only the place the search missed', async () => {
  assert.equal((await uw(['new', 'sv', '--title', 'Seville in 3 days', '--ask', 'Where to stay and what to see each day', '--center', CITY.join(','), '--zoom', '13', '--expect', 'Seville:3'])).code, 0);
  const stop = await uw(['add-point', 'sv', '--layer', 'stops', '--query', 'Seville', '--country', 'Spain', '--kind', 'city', '--id', 'seville', '--name', 'Seville', '--props', '{"nights":3}', '--json']);
  assert.equal(stop.code, 0, stop.out + stop.err);
  const stays = await uw(['stay', 'sv', '--near', SANTA_CRUZ.join(','), '--near-label', 'Santa Cruz', '--stop', 'seville', '--kinds', 'hotel', '--json']);
  assert.equal(stays.code, 0, stays.out + stays.err);
  for (const s of SIGHTS) {
    const r = await addSight('sv', s);
    assert.equal(r.code, 0, `${s.q}: the search's first hit in range is the place, never "Not found yet": ${r.out}${r.err}`);
    assert.equal(r.json.id, s.id);
  }
  // the search's first hit for each of the run's three refused sights is the place itself
  const kinds = Object.fromEntries(layerOf('sv', 'sights').map((f) => [f.properties.id, f.properties.kind]));
  assert.deepEqual([kinds.alcazar, kinds.triana], ['castle', 'suburb']);
  const missed = await addSight('sv', MISSED);
  assert.equal(missed.code, 2, missed.out + missed.err);

  // the slow lookup: started, and its command has not finished when the plan is made
  const slow = addSight('sv', SLOW);
  await held.arrived;
  const plan = await uw(['plan', 'sv', ...PLAN, '--json']);
  assert.equal(plan.code, 0, plan.out + plan.err);
  assert.equal(plan.json.still_running.length, 1, JSON.stringify(plan.json.still_running));
  assert.match(plan.json.still_running[0], /^uw add-point --layer sights --query "Casa de Pilatos" --country Spain --strict-name /);
  assert.match(plan.json.next, /^Still running on this site: uw add-point --layer sights --query "Casa de Pilatos" .* \(\d+ s so far\)\. What it finds is not in this plan yet: wait until it has finished \(an exit code; never start it again\), then run this command again with --force\.$/);
  const text = await uw(['validate', 'sv', '--signal']);
  assert.equal(text.code, 1, text.out);
  assert.match(text.out, /^ERROR data\/: still running on this site: uw add-point --layer sights --query "Casa de Pilatos" .* \(\d+ s so far\); what it finds is not on the map yet\n {6}fix: wait until it has finished \(an exit code; never start it again\), then uw plan … --force \(its days take what was found\) and validate again$/m);
  const v1 = await uw(['validate', 'sv', '--json']);
  assert.ok(v1.json.errors.some((e) => /^still running on this site: uw add-point .*"Casa de Pilatos"/.test(e.message)), JSON.stringify(v1.json.errors, null, 1));
  // a lookup still running is not "Not found yet"
  assert.deepEqual(cfgOf('sv').missing.map((m) => m.name), [MISSED.q]);

  held.released = true;
  for (const f of held.pending.splice(0)) f();
  const done = await slow;
  assert.equal(done.code, 0, done.out + done.err);
  // finished, but the days were planned while it ran: its place is on the map and in no day, and validate fails until
  // the days are planned again (every day already had two sights, so no day was empty)
  assert.equal((await uw(['fit', 'sv'])).code, 0);
  const stale = await uw(['validate', 'sv', '--signal', '--json']);
  assert.equal(stale.code, 1, stale.out);
  assert.deepEqual(stale.json.errors.map((e) => e.message), ['on the map but in no day of the plan: Casa de Pilatos (pinned after the days were planned)']);
  assert.match(stale.json.errors[0].fix, /^uw plan sv … --sights sights --force: /);
  // planned again: nothing is named any more, and the days take it
  const again = await uw(['plan', 'sv', ...PLAN, '--force', '--json']);
  assert.equal(again.code, 0, again.out + again.err);
  assert.equal(again.json.still_running, undefined);
  const days = cfgOf('sv').plan.days;
  assert.deepEqual(days.map((d) => d.title), ['Sat 31 Oct · Seville', 'Sun 1 Nov · Seville', 'Mon 2 Nov · Seville']);
  const pages = Object.fromEntries([...SIGHTS, SLOW].map((s) => [s.id, s.page]));
  for (const d of days) {
    const sights = d.items.filter((it) => it.ref?.layer === 'sights');
    assert.ok(sights.length >= 2 && sights.length <= 3, `${d.title}: ${sights.map((it) => it.text).join(', ')}`);
    for (const it of sights) assert.equal(it.url, pages[it.ref.id], `${it.text} links its own page`);
  }
  assert.equal(days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights')).length, 7, 'every sight on a day');
  // "Not found yet" lists only the place the search missed
  const cfg = cfgOf('sv');
  assert.deepEqual(cfg.missing.map((m) => m.name), [MISSED.q]);
  // days in one place: the stop is the city the map shows, not a group in the places list
  assert.equal(cfg.layers.find((l) => l.id === 'stops').list, false);
  assert.notEqual(cfg.layers.find((l) => l.id === 'sights').list, false);
  // each place draws its own sign (the map draws a layer's style.emoji, when it has one, on every place of the layer):
  // the cathedral the neutral sign of a place of worship, not a shrine gate or the palace's castle, which was the
  // first sight pinned
  const sightsDef = cfg.layers.find((l) => l.id === 'sights');
  const drawn = Object.fromEntries(layerOf('sv', 'sights').map((f) => [f.properties.id, sightsDef.style?.emoji || f.properties.emoji]));
  assert.equal(drawn.cathedral, '🛐');
  assert.equal(drawn.alcazar, '🏰', 'a castle, any country\'s');
  assert.equal(new Set(Object.values(drawn)).size > 3, true, JSON.stringify(drawn));
  assert.equal((await uw(['fit', 'sv'])).code, 0);
  const v2 = await uw(['validate', 'sv', '--signal', '--json']);
  assert.equal(v2.code, 0, JSON.stringify(v2.json?.errors ?? v2.out, null, 1));
  assert.deepEqual(v2.json.errors, []);
  // a place the days have no room for (two a day) is said by uw plan, and is not one pinned after them
  const tight = await uw(['plan', 'sv', ...PLAN, '--per-day', '2', '--force', '--json']);
  assert.equal(tight.code, 0, tight.out + tight.err);
  assert.equal(tight.json.not_on_plan.length, 1, JSON.stringify(tight.json.not_on_plan));
  const v3 = await uw(['validate', 'sv', '--signal', '--json']);
  assert.equal(v3.code, 0, JSON.stringify(v3.json?.errors ?? v3.out, null, 1));
  assert.deepEqual(v3.json.errors, []);
});

test('a trip of several stops lists its stops again', async () => {
  const site = 'sv-trip';
  assert.equal((await uw(['new', site, '--title', 'Seville and Córdoba', '--center', '-5.4,37.6', '--zoom', '8', '--expect', 'Seville:2,Córdoba:2'])).code, 0);
  for (const [id, name, c] of [['seville', 'Seville', CITY.join(',')], ['cordoba', 'Córdoba', '-4.7794,37.8882']]) {
    assert.equal((await uw(['add-point', site, '--layer', 'stops', '--at', c, '--name', name, '--id', id, '--kind', 'city', '--props', '{"nights":2}'])).code, 0);
  }
  const one = await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '2', '--start', '2026-11-01']);
  assert.equal(one.code, 0, one.out + one.err);
  assert.equal(cfgOf(site).layers.find((l) => l.id === 'stops').list, false);
  const two = await uw(['plan', site, '--stops', 'stops', '--ids', 'seville,cordoba', '--nights', '2,2', '--start', '2026-11-01', '--force']);
  assert.equal(two.code, 0, two.out + two.err);
  assert.equal('list' in cfgOf(site).layers.find((l) => l.id === 'stops'), false);
});

// The 1 Nov 2026 Seville map (days in one place) listed "Stations 1": the turn had placed the city's station with
// `uw station`, whose layer is listed. Days in one place list neither the stop nor its station; both stay on the map.
test('days in one place list no Stations group either; a trip of several stops lists its stations again', async () => {
  const site = 'sv-station';
  assert.equal((await uw(['new', site, '--title', 'Three days in Seville', '--center', CITY.join(','), '--zoom', '13', '--expect', 'Seville:3'])).code, 0);
  for (const [id, name, c] of [['seville', 'Seville', CITY.join(',')], ['cordoba', 'Córdoba', '-4.7794,37.8882']]) {
    assert.equal((await uw(['add-point', site, '--layer', 'stops', '--at', c, '--name', name, '--id', id, '--kind', 'city', '--props', '{"nights":2}'])).code, 0);
  }
  // the station, as `uw station` writes and registers it (Sevilla - Santa Justa)
  const station = { type: 'Feature', geometry: { type: 'Point', coordinates: [-5.975281, 37.392027] },
    properties: { id: 'seville', name: 'Sevilla - Santa Justa', kind: 'train_station', emoji: '🚉', station_of: 'Seville', station_kind: 'rail', source: 'OpenStreetMap' } };
  fs.writeFileSync(path.join(tmp, site, 'data', 'stations.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'station' }, features: [station] }));
  const cfg = cfgOf(site);
  cfg.layers.push({ id: 'stations', title: 'Stations', type: 'points', data: 'data/stations.geojson', tier: 'support', style: { emoji: '🚉', color: '#475569' }, list: true });
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  const one = await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-02']);
  assert.equal(one.code, 0, one.out + one.err);
  const layers = cfgOf(site).layers;
  assert.equal(layers.find((l) => l.id === 'stations').list, false, 'no "Stations 1" in the places list');
  assert.equal(layers.find((l) => l.id === 'stops').list, false);
  // still on the map: the layer and its point stay
  assert.equal(layerOf(site, 'stations').length, 1);
  assert.notEqual(layers.find((l) => l.id === 'stations').visible, false);
  const two = await uw(['plan', site, '--stops', 'stops', '--ids', 'seville,cordoba', '--nights', '2,2', '--start', '2026-11-02', '--force']);
  assert.equal(two.code, 0, two.out + two.err);
  assert.equal(cfgOf(site).layers.find((l) => l.id === 'stations').list, undefined, 'listed again: a trip\'s stations are its places');
});

test('the area is where the place can be: a far-off hit\'s town never makes the query\'s own words area words', async () => {
  assert.equal((await uw(['new', 'sv-names', '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  // "Alcázar" is a word of the name, though the search also found streets in Alcázar de San Juan, 330 km away
  const r = await addSight('sv-names', { id: 'alcazar', q: 'Royal Alcázar of Seville', page: 'https://en.wikipedia.org/wiki/Alc%C3%A1zar_of_Seville', why: 'the royal palace' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.chosen.name, 'Real Alcázar de Sevilla');
  assert.equal(cfgOf('sv-names').missing, undefined);
});

test('a hit whose own name is the query\'s name matches, even when each word of it is generic or names the area', () => {
  const sevilla = { ...SEV, city_en: 'Seville', state_en: 'Andalusia', country_en: 'Spain' };
  const area = areaWordsOf([sevilla, { ...sevilla, district: 'Triana' }]);
  assert.equal(nameMatches('Plaza de España, Seville', ['Plaza de España'], area), null, 'nothing distinctive is left of the query');
  assert.equal(nameMatchFor('Plaza de España, Seville', ['Plaza de España'], area), true);
  assert.equal(nameMatchFor('Triana, Seville', ['Triana'], area), true);
  assert.equal(nameMatchFor('Triana, Seville', ['Triana Este'], area), null, 'only the same name, not a name that contains it');
  assert.equal(nameMatchFor('Plaza de España, Seville', ['Fuente Plaza de España'], area), null);
  // a query word that only names the area is still no match
  const sheraton = { name: 'Sheraton Taitung Hotel', city: 'Taitung City', country: 'Taiwan' };
  assert.equal(nameMatchFor('Kindness Hotel Taitung', [sheraton.name], areaWordsOf([sheraton])), false);
});

test('a command still running on a site is named until it ends; one that is gone, out of time or of the same run is not', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'site-'));
  const folder = path.join(dir, '.uwcache', 'running');
  fs.mkdirSync(folder, { recursive: true });
  const put = (e) => { const f = path.join(folder, `${e.pid}.json`); fs.writeFileSync(f, JSON.stringify(e)); return f; };
  // a uw command in another process (its command line names uw.mjs, as every uw command's does)
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'uw.mjs'], { stdio: 'ignore' });
  try {
    const label = 'uw add-point --layer sights --query "Casa de Pilatos" --country Spain --strict-name';
    const live = { pid: other.pid, run: String(other.pid), cmd: 'add-point', label, started_at: new Date(Date.now() - 5000).toISOString(), until: new Date(Date.now() + 60000).toISOString() };
    const file = put(live);
    const list = stillRunning(dir, { env: {} });
    assert.deepEqual(list.map((r) => [r.pid, r.cmd, r.label]), [[other.pid, 'add-point', label]]);
    assert.match(runningList(list), /^uw add-point --layer sights --query "Casa de Pilatos" --country Spain --strict-name \([56] s so far\)$/);
    // a step of the same run (uw handoff --apply runs its steps as uw commands): never its own run's
    assert.deepEqual(stillRunning(dir, { env: { UW_RUN_ID: String(other.pid) } }), []);
    assert.ok(fs.existsSync(file));
    // out of time: not named, and its file goes
    put({ ...live, until: new Date(Date.now() - 1000).toISOString() });
    assert.deepEqual(stillRunning(dir, { env: {} }), []);
    assert.equal(fs.existsSync(file), false);
    // gone (killed with its turn): not named, and its file goes
    const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((r) => gone.on('exit', r));
    const goneFile = put({ ...live, pid: gone.pid, run: String(gone.pid) });
    assert.deepEqual(stillRunning(dir, { env: {} }), []);
    assert.equal(fs.existsSync(goneFile), false);
  } finally { other.kill(); }
  // the label: the command and its arguments, shortened
  assert.equal(commandLabel('add-point', ['--layer', 'sights', '--query', 'Plaza de España, Seville', '--json']), 'uw add-point --layer sights --query "Plaza de España, Seville"');
  assert.match(commandLabel('stay', Array.from({ length: 40 }, (_, i) => `--x${i}`)), /^uw stay --x0 .* …$/);
  assert.ok(commandLabel('stay', Array.from({ length: 40 }, (_, i) => `--x${i}`)).length <= 112);
});

test('SKILL.md: the turn clock decides when to reply, not "time to spare"', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(md, /^Hosted turns stop at 10 min: card \+ map \+ verdict early\.$/m);
  assert.doesNotMatch(md, /time to spare/);
  assert.match(md, /`uw question` and `uw validate` print the time used and left; under ~3 min left: start nothing slow, reply\./);
});

test('a place of worship has the neutral sign: any faith\'s, never one faith\'s', () => {
  assert.equal(emojiFor('place_of_worship'), '🛐');
  // a temple is a Buddhist, Taoist, Hindu, Jain … one as much as a Shinto one; only a shrine (Shinto) has the gate
  assert.equal(emojiFor('temple'), '🛐');
  assert.equal(emojiFor('shrine'), '⛩️');
  // a castle, any country's (the Alcázar of Seville showed a Japanese castle)
  assert.equal(emojiFor('castle'), '🏰');
});
