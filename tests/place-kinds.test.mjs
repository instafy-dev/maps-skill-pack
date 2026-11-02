// A 3-day Seville map put "Murillo Gardens" on the map as Casa de Murillo, a museum (the gardens were the search's
// third answer), and "Metropol Parasol" as a playground in the square named after it; the hotel was made the trip's
// stop, so every day read "Mon 2 Nov · Hotel Alfonso XIII"; and the places to stay read "2 min walk to the chosen
// point". Now:
//  - `uw add-point` takes the kind of place the query names (a garden, a park, a square), and exits 2 with its
//    alternatives when no candidate is that kind; a playground, a car park … that only stands in the place a query
//    names is never that place unless the query asks for one;
//  - `uw plan` refuses a place to stay as a trip's stop: the city is the stop and the hotel its stay;
//  - `uw stay` with a point for --near and no --near-label exits 2 and asks for one, before any lookup.
// Offline: the place search, the lodging search and the walking router are a local mock in this file.
// Run: node --test tests/place-kinds.test.mjs
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
const { queryType } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-geocode.mjs')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-place-kinds-'));

// ---------------------------------------------------------------------------
// The place search's answers, as the 2 Nov 2026 run got them (OpenStreetMap names, kinds and positions, in the
// search's answer shape); "Prueba" answers are made up
const CITY = [-5.99534, 37.38863];
const SEV = { city: 'Sevilla', county: 'Sevilla', state: 'Andalucía', country: 'España', countrycode: 'ES', district: 'Casco Antiguo' };
const hit = (c, osm, name, more = {}) => {
  const [osm_type, osm_id, osm_key, osm_value] = osm;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osm_type, osm_id, osm_key, osm_value, name, ...SEV, ...more } };
};
const ANSWERS = {
  // the museum first, the gardens third
  'Murillo Gardens, Seville': [
    hit([-5.989081, 37.385717], ['N', 4647829792, 'tourism', 'museum'], 'Casa de Murillo', { street: 'Calle Santa Teresa', housenumber: '8' }),
    hit([-5.99945, 37.378187], ['N', 6617489619, 'amenity', 'dentist'], 'Clínica Dental y Estética (Dra. C. Ruiz Murillo-Rico)', { district: 'Los Remedios' }),
    hit([-5.987827, 37.383685], ['W', 22747191, 'leisure', 'park'], 'Jardines de Murillo'),
    hit([-5.997573, 37.390855], ['W', 37246859, 'highway', 'residential'], 'Calle Murillo'),
  ],
  // a building with the place's other name, and a playground named after the square it is on
  'Metropol Parasol, Seville': [
    hit([-5.991853, 37.393119], ['W', 138602581, 'building', 'yes'], 'Setas de Sevilla', { street: 'Calle Imagen' }),
    hit([-5.991921, 37.393403], ['N', 3141651338, 'leisure', 'playground'], 'Parque Metropol Parasol', { street: 'Plaza de la Encarnación' }),
  ],
  // no garden of that name at all: a museum and a street
  'Prueba Gardens, Seville': [
    hit([-5.9851, 37.3901], ['N', 9911, 'tourism', 'museum'], 'Casa de Prueba'),
    hit([-5.9861, 37.3911], ['W', 9912, 'highway', 'residential'], 'Calle Prueba'),
  ],
  // a hotel named like a square
  'Plaza de Prueba, Seville': [
    hit([-5.9871, 37.3881], ['N', 9913, 'tourism', 'hotel'], 'Plaza de Prueba'),
  ],
  'Playground Prueba, Seville': [
    hit([-5.9881, 37.3871], ['N', 9914, 'leisure', 'playground'], 'Playground Prueba'),
  ],
};
// answers to a search with osm_tag filters (the search for the kind itself): none for these places
const TAGGED = {};
const off = (c, dx, dy) => [Math.round((c[0] + dx / 88400) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
// the lodging search's answer around the centre
const LODGING = [
  { type: 'node', id: 811, c: off(CITY, 120, 0), tags: { tourism: 'hotel', name: 'Hotel Plaza' } },
  { type: 'node', id: 812, c: off(CITY, 0, 180), tags: { tourism: 'hotel', name: 'Hotel Inglaterra' } },
  { type: 'node', id: 813, c: off(CITY, -150, -100), tags: { tourism: 'hotel', name: 'Hotel Europa' } },
];

let mock;
const hits = [];
before(async () => {
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
      const q = u.searchParams.get('q') || '';
      const tags = u.searchParams.getAll('osm_tag');
      const feats = tags.length ? (TAGGED[q] || []).filter((f) => tags.includes(`${f.properties.osm_key}:${f.properties.osm_value}`)) : ANSWERS[q] || [];
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
        const elements = /"tourism"~/.test(q) ? LODGING.filter(near).map((e) => ({ type: e.type, id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags })) : [];
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

const uw = (args, { input = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_NO_CACHE: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  // the pack's own turn clock, never that of a turn running these tests
  for (const k of ['UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features; } catch { return []; } };
const newSite = async (site, more = []) => assert.equal((await uw(['new', site, '--title', '3 days in Seville', '--center', CITY.join(','), '--zoom', '13', ...more])).code, 0);
const sight = (site, id, q, more = []) => uw(['add-point', site, '--layer', 'sights', '--query', q, '--near', CITY.join(','), '--id', id, ...more, '--json']);

// ---------------------------------------------------------------------------
test('add-point: a query that names a garden takes the garden, not the museum the search listed first', async () => {
  await newSite('kinds');
  const r = await sight('kinds', 'murillo', 'Murillo Gardens, Seville');
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual([r.json.chosen.name, r.json.chosen.type], ['Jardines de Murillo', 'leisure=park']);
  assert.ok(r.json.alternatives.some((c) => c.name === 'Casa de Murillo'), 'the museum stays an alternative (--pick)');
  assert.equal(layerOf('kinds', 'sights').find((f) => f.properties.id === 'murillo').properties.kind, 'park');
});

test('add-point: no candidate is the kind of place the query names: exit 2 with the alternatives, nothing written', async () => {
  await newSite('kinds-none');
  const r = await sight('kinds-none', 'prueba', 'Prueba Gardens, Seville');
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(r.json.refused, 'type_mismatch');
  assert.match(r.err, /REFUSED: no candidate nearby is the kind of place "Prueba Gardens, Seville" names \(best in range: "Casa de Prueba" \[tourism=museum\]\)/);
  assert.match(r.err, /1\. Casa de Prueba \[tourism=museum\][\s\S]*2\. Calle Prueba \[highway=residential\]/, 'its alternatives, numbered for --pick');
  assert.match(r.err, /If one candidate IS the place, re-run with --pick N/);
  assert.deepEqual(layerOf('kinds-none', 'sights'), []);
  // --pick takes one as it is
  const p = await sight('kinds-none', 'prueba', 'Prueba Gardens, Seville', ['--pick', '1']);
  assert.equal(p.code, 0, p.out + p.err);
  assert.equal(p.json.chosen.name, 'Casa de Prueba');
});

test('add-point: a playground named after the place is not that place: exit 2 names it, and --pick takes the place', async () => {
  await newSite('kinds-stand');
  const r = await sight('kinds-stand', 'setas', 'Metropol Parasol, Seville');
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(r.json.refused, 'stands_in');
  assert.match(r.err, /REFUSED: "Parque Metropol Parasol" \[leisure=playground\] only stands in the place "Metropol Parasol, Seville" names and takes its name; no other candidate is named like it/);
  assert.match(r.err, /1\. Setas de Sevilla \[building=yes\]/);
  assert.deepEqual(layerOf('kinds-stand', 'sights'), []);
  const p = await sight('kinds-stand', 'setas', 'Metropol Parasol, Seville', ['--pick', '1']);
  assert.equal(p.code, 0, p.out + p.err);
  assert.equal(p.json.chosen.name, 'Setas de Sevilla');
  // a query that asks for the playground gets it
  const g = await sight('kinds-stand', 'playground', 'Playground Prueba, Seville');
  assert.equal(g.code, 0, g.out + g.err);
  assert.equal(g.json.chosen.type, 'leisure=playground');
});

test('the kind is the name\'s head word, and a place to stay or --kind says what the place is', async () => {
  const kind = (q, o) => queryType(q, o)?.tags[0] ?? null;
  assert.equal(kind('Murillo Gardens, Seville'), 'leisure:park');
  assert.equal(kind('Jardines de Murillo, Sevilla'), 'leisure:park');
  assert.equal(kind('Hyde Park, London'), 'leisure:park');
  assert.equal(kind('Trafalgar Square'), 'place:square');
  assert.equal(kind('Praça do Comércio, Lisboa'), 'place:square');
  assert.equal(kind('Piazza Navona'), 'place:square');
  // a street, a hotel or a car park named with the word is not that kind
  for (const q of ['Park Lane, London', 'Park Hyatt Tokyo', 'Hyde Park Car Park', 'Gardens by the Bay']) assert.equal(kind(q), null, q);
  assert.equal(kind('Plaza Hotel, New York'), 'tourism:hotel');
  assert.equal(kind('Plaza de Prueba, Seville', { open: false }), null);
  // in a layer of places to stay, a hotel named like a square is that hotel; among sights it is refused
  await newSite('kinds-stay');
  const s = await uw(['add-point', 'kinds-stay', '--layer', 'stays', '--query', 'Plaza de Prueba, Seville', '--near', CITY.join(','), '--id', 'hotel', '--json']);
  assert.equal(s.code, 0, s.out + s.err);
  assert.equal(s.json.chosen.type, 'tourism=hotel');
  const k = await uw(['add-point', 'kinds-stay', '--layer', 'sights', '--query', 'Plaza de Prueba, Seville', '--near', CITY.join(','), '--kind', 'hotel', '--id', 'hotel2', '--json']);
  assert.equal(k.code, 0, k.out + k.err);
  assert.equal((await sight('kinds-stay', 'square', 'Plaza de Prueba, Seville')).code, 2);
});

// ---------------------------------------------------------------------------
test('plan: a place to stay is not a trip\'s stop; the city is, and the days read its name', async () => {
  const site = 'stop';
  await newSite(site, ['--expect', 'Seville:3']);
  const hotel = await uw(['add-point', site, '--layer', 'stays', '--at', '-5.992719,37.381517', '--name', 'Hotel Alfonso XIII', '--kind', 'hotel', '--id', 'base-hotel', '--props', '{"nights":3}']);
  assert.equal(hotel.code, 0, hotel.out + hotel.err);
  const r = await uw(['plan', site, '--stops', 'stays', '--ids', 'base-hotel', '--nights', '3', '--start', '2026-11-02']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /"Hotel Alfonso XIII" is a place to stay, not a trip's stop: the city \(Seville\) is the stop and "Hotel Alfonso XIII" its stay, so each day reads "Seville"\./);
  assert.match(r.err, /Pin the city: uw add-point stop --layer stops --query "Seville" --kind city --id seville --props '\{"nights":3\}'; give the stay that stop: uw set stop stays:base-hotel --props '\{"stop":"seville"\}'; then uw plan stop --stops stops --ids seville … --stays stays/);
  assert.equal(cfgOf(site).plan, undefined, 'no plan was written');
  // as the line says
  assert.equal((await uw(['add-point', site, '--layer', 'stops', '--at', CITY.join(','), '--name', 'Seville', '--kind', 'city', '--id', 'seville', '--props', '{"nights":3}'])).code, 0);
  assert.equal((await uw(['set', site, 'stays:base-hotel', '--props', '{"stop":"seville"}'])).code, 0);
  const ok = await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-02', '--stays', 'stays', '--json']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  const days = cfgOf(site).plan.days;
  assert.deepEqual(days.map((d) => d.title), ['Mon 2 Nov · Seville', 'Tue 3 Nov · Seville', 'Wed 4 Nov · Seville']);
  assert.match(days[0].text, /^Arrive in Seville; night 1 of 3\./);
  assert.deepEqual(days[0].focus, { layer: 'stays', id: 'base-hotel' }, 'the hotel is the base');
});

test('plan: a place to stay the trip names as one of its stops stays a stop (a night at a hotel that is the destination)', async () => {
  const site = 'stop-named';
  await newSite(site, ['--expect', 'Kiruna:2,Icehotel:1']);
  assert.equal((await uw(['add-point', site, '--layer', 'stops', '--at', '20.2253,67.8558', '--name', 'Kiruna', '--kind', 'city', '--id', 'kiruna', '--allow-far', '--no-fit'])).code, 0);
  assert.equal((await uw(['add-point', site, '--layer', 'stops', '--at', '20.8000,67.8500', '--name', 'Icehotel', '--kind', 'hotel', '--id', 'icehotel', '--allow-far', '--no-fit'])).code, 0);
  const r = await uw(['plan', site, '--stops', 'stops', '--ids', 'kiruna,icehotel', '--nights', '2,1', '--start', '2026-12-01']);
  assert.equal(r.code, 0, r.out + r.err);
});

// ---------------------------------------------------------------------------
test('stay: a point for --near needs --near-label (exit 2, nothing looked up); with one, each stay names it', async () => {
  const site = 'near';
  await newSite(site, ['--expect', 'Seville:3']);
  const before = hits.length;
  const r = await uw(['stay', site, '--near', CITY.join(','), '--stop', 'seville', '--kinds', 'hotel']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /--near -5\.99534,37\.38863 is a point: name it with --near-label as the traveller would \("the centre of Seville", or the area's name\), since each stay reads "4 min walk to <it>"/);
  assert.equal(hits.length, before, 'nothing was looked up');
  assert.deepEqual(layerOf(site, 'stays'), []);
  const ok = await uw(['stay', site, '--near', CITY.join(','), '--near-label', 'the centre of Seville', '--stop', 'seville', '--kinds', 'hotel', '--json']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  const stays = layerOf(site, 'stays');
  assert.equal(stays.length, 3);
  for (const f of stays) assert.match(f.properties.why, /^\d+ min walk to the centre of Seville · hotel$/);
  assert.doesNotMatch(JSON.stringify(stays), /chosen point/);
});
