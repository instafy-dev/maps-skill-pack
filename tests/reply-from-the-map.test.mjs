// A "3 days, one around <two places the person named>" map got no days. The turn pinned the two named places without
// the named mark; its sights' pages were refused one by one as not read yet ("cite it first"), so each took a second
// command, and the last one, its time running out, never went in; `uw plan` refused the days for one short day. The map
// read "Not found yet: Main Market Square" over its own pin for the square: the lookup by that name was refused (its
// best match, "Rynek Główny / Main Square", is named only with words that name no place on their own), and the turn
// pinned that very square by its local name, under another id. The reply then blamed the gap on the square and named a
// site no place cited, and the next reply asked the person to add a sight. Now:
//  - the trip guide pins the places the message names first, each with "asked": true, in a step of its own, and they
//    stay on their day;
//  - `uw add-point` and `uw set` read a page no uw cite read themselves, as uw cite would, and pin the place in the same
//    command (one they cannot read is refused with why);
//  - pinning a place that a "not found" entry names takes the entry off: by the same query, or as the square the
//    refused lookup found under another name (its OpenStreetMap object, or a pin of its name inside it); a place a pin
//    already is is never listed, and `uw validate` fails an entry beside its own pin;
//  - `uw validate` lists the sources the map cites, for the reply's Sources line, and the trip guide's reply takes its
//    days, gaps and sources from `uw plan` and `uw validate`: never another cause, never a site no place cites, and
//    never asking the person to add a place (it says which day is short and offers to add one).
// Offline: the place search, the lodging search, the walking router and the pages are a local mock in this file (uw
// cite reads 127.0.0.1 with UW_ALLOW_LOCAL=1); what is read is kept in this test's own cache, as in a space. The pages
// of the places on the days are at https:// addresses (the Plan tab links only those), put in that cache as uw cite
// keeps what it read; the page the turn's own add-point reads is the mock's.
// Run: node --test tests/reply-from-the-map.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-reply-from-the-map-'));
// what uw cite read, kept the way it keeps it (this test's own shared cache)
delete process.env.UW_NO_CACHE;
process.env.UW_CACHE = path.join(tmp, 'cache');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { haversine } = await lib('util.mjs');
const { missedPlace, pinNamesMissing } = await lib('missing.mjs');
const { sourcesCited } = await lib('cmd-validate.mjs');
const { rememberCited } = await lib('cmd-cite.mjs');
const read = (url, text) => rememberCited([url], { url, title: '', retrieved_at: new Date().toISOString(), text });

// ---------------------------------------------------------------------------
// The city, its old town and the places, at the positions OpenStreetMap has (rounded)
const CITY = [19.936856, 50.061947];
const SQUARE = { osm_type: 'W', osm_id: 201133718, osm_key: 'place', osm_value: 'square', name: 'Rynek Główny', name_en: 'Main Square', at: [19.937113, 50.061496],
  extent: [19.9355, 50.0627, 19.9389, 50.0603] };
const AREA = { city: 'Kraków', district: 'Stare Miasto', state: 'województwo małopolskie', country: 'Polska', countrycode: 'PL' };
const WIKI = 'https://en.wikipedia.org/wiki/';
const NAMED = [
  { id: 'kazimierz', name: 'Kazimierz', at: [19.944896, 50.051426] },
  { id: 'wawel-castle', name: 'Wawel Castle', at: [19.935, 50.054], page: `${WIKI}Wawel_Castle`, text: 'Wawel Castle\nThe royal castle on the hill by the river.' },
];
const SQUARE_PAGE = { page: `${WIKI}Main_Square,_Krak%C3%B3w`, text: 'Main Square, Kraków\nRynek Główny, the main square of the old town.' };
const CHOSEN = [
  { id: 'st-marys', name: "St. Mary's Basilica", at: [19.939316, 50.061662], page: `${WIKI}St._Mary%27s_Basilica,_Krak%C3%B3w`, text: "St. Mary's Basilica\nThe brick church on the main square." },
  { id: 'cloth-hall', name: 'Cloth Hall', at: [19.937346, 50.061677], page: `${WIKI}Krak%C3%B3w_Cloth_Hall`, text: 'Cloth Hall\nThe market hall in the middle of the main square.' },
  { id: 'old-synagogue', name: 'Old Synagogue', at: [19.948613, 50.051372], page: `${WIKI}Old_Synagogue_(Krak%C3%B3w)`, text: 'Old Synagogue\nThe oldest synagogue standing in the quarter.' },
];
// a food hall, whose page no uw cite read: the turn's own add-point reads it (the mock's)
const MARKET = { id: 'hala-targowa', name: 'Hala Targowa', at: [19.950713, 50.058425], page: '/wiki/Hala_Targowa' };
const PAGES = {
  '/wiki/Hala_Targowa': '<html><head><title>Hala Targowa - Wikipedia</title></head><body><h1>Hala Targowa</h1><p>The covered market by the river.</p></body></html>',
};
const off = (c, dx, dy) => [Math.round((c[0] + dx / 71000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const LODGING = [
  { type: 'node', id: 4749733846, c: off(CITY, -110, -70), tags: { tourism: 'hotel', name: 'Palladian' } },
  { type: 'node', id: 702, c: off(CITY, 160, 90), tags: { tourism: 'hotel', name: 'Hotel Wentzl' } },
  { type: 'node', id: 703, c: off(CITY, -200, 150), tags: { tourism: 'hotel', name: 'Hotel Saski' } },
];
// the square, as the place search answers: by its local name, or in English with lang=en; any query that names it
const squareFeature = (lang) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: SQUARE.at },
  properties: { osm_type: SQUARE.osm_type, osm_id: SQUARE.osm_id, osm_key: SQUARE.osm_key, osm_value: SQUARE.osm_value, name: lang === 'en' ? SQUARE.name_en : SQUARE.name, extent: SQUARE.extent, ...AREA } });
const SQUARE_QUERY = /^(Main Market Square|Rynek Główny|Main Square)\b/;

let mock;
const hits = { pages: [], search: 0 };
before(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.includes('/table/v1/')) {
      const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
      const d = pts.map((p) => haversine(pts[0], p) * 1.2);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'Ok', durations: [d.map((m) => m / 1.25)], distances: [d] }));
      return;
    }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        const elements = /"tourism"~/.test(q) ? LODGING.filter(near).map((e) => ({ type: e.type, id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags })) : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ elements }));
      });
      return;
    }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      hits.search++;
      const q = u.searchParams.get('q') || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'FeatureCollection', features: !u.searchParams.getAll('osm_tag').length && SQUARE_QUERY.test(q) ? [squareFeature(u.searchParams.get('lang'))] : [] }));
      return;
    }
    if (u.pathname === '/reverse') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n'); return; }
    hits.pages.push(u.pathname);
    if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[u.pathname]); return; }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>Page not found</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mock = { server, url: `http://127.0.0.1:${server.address().port}` };
});
after(() => {
  mock?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// a fresh turn by the pack's own clock (eight minutes for tool work), the cache on, as in a space
const uw = (args, { input = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_ALLOW_LOCAL: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_HANDOFF_STEP', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const sightsOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', 'sights.geojson'), 'utf8')).features;
const pageOf = (s) => (s.page?.startsWith('/') ? `${mock.url}${s.page}` : s.page);
const props = (s, more = {}) => JSON.stringify({ stop: 'krakow', ...(s.page ? { source_url: pageOf(s), source: 'Wikipedia' } : {}), ...more });
const pinAt = (site, s, more = {}, layer = 'sights') => uw(['add-point', site, '--layer', layer, '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'], { input: props(s, more) });
const pinBy = (site, query, id, s, more = []) => uw(['add-point', site, '--layer', 'sights', '--query', query, '--country', 'PL', '--strict-name', '--near', CITY.join(','), '--id', id, ...more, '--props-file', '-'],
  { input: props(s) });
const trip = async (site) => {
  assert.equal((await uw(['new', site, '--title', 'Three days in Kraków', '--ask', 'Where to stay and what to see each day', '--center', CITY.join(','), '--zoom', '13', '--expect', 'Kraków:3'])).code, 0);
  const s = await uw(['add-point', site, '--layer', 'stops', '--at', CITY.join(','), '--name', 'Kraków', '--kind', 'city', '--id', 'krakow', '--props', JSON.stringify({ nights: 3 })]);
  assert.equal(s.code, 0, s.out + s.err);
  const stays = await uw(['stay', site, '--near', CITY.join(','), '--near-label', 'the old town', '--stop', 'krakow', '--kinds', 'hotel']);
  assert.equal(stays.code, 0, stays.out + stays.err);
};
const plan = (site, more = []) => uw(['plan', site, '--stops', 'stops', '--ids', 'krakow', '--nights', '3', '--start', '2026-11-20', '--stays', 'stays', '--sights', 'sights', ...more, '--force']);

// ---------------------------------------------------------------------------
test('the trip as the guide now has it: the named places first and marked, the square\'s "not found" entry gone with its pin, a page no uw cite read read by the command that pins its place; the days pass, the named places on theirs, and validate lists the sources', async () => {
  const site = 'krakow';
  await trip(site);
  // the pages uw cite read for the places on the days (a place the person named may have none yet)
  for (const s of [...NAMED, SQUARE_PAGE, ...CHOSEN]) if (s.text) read(s.page, s.text);
  // the places the message names, first, each marked
  for (const s of NAMED) assert.equal((await pinAt(site, s, { asked: true })).code, 0);
  // the square by the name the turn had for it: refused (no candidate is named like it), and listed as not found, with
  // the place its lookup found under another name
  const square = { name: 'Main Square', page: SQUARE_PAGE.page };
  const refused = await pinBy(site, 'Main Market Square, Kraków', 'main-square', square, ['--json']);
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.equal(refused.json.refused, 'name_mismatch');
  const [entry] = cfgOf(site).missing;
  assert.deepEqual(entry.place, { osm_id: 'osm-w201133718', names: ['Rynek Główny', 'Main Square'], at: SQUARE.at, bbox: [19.9355, 50.0603, 19.9389, 50.0627] });
  // then by its local name, under another id: pinned, and the entry is gone
  const pinned = await pinBy(site, 'Rynek Główny Kraków', 'market-square', square);
  assert.equal(pinned.code, 0, pinned.out + pinned.err);
  assert.match(pinned.out, /removed its "not found yet" entry/);
  assert.equal(cfgOf(site).missing, undefined, 'nothing pinned reads "Not found yet"');
  for (const s of CHOSEN) assert.equal((await pinAt(site, s)).code, 0);
  // the food hall's page, which no uw cite read: read by the add-point that pins it, in the same command
  const market = await pinAt(site, MARKET, {}, 'food');
  assert.equal(market.code, 0, market.out + market.err);
  assert.ok(market.err.includes(`Read ${pageOf(MARKET)} for "Hala Targowa", as uw cite would (127.0.0.1 · "Hala Targowa - Wikipedia").`), market.err);
  assert.deepEqual(hits.pages, ['/wiki/Hala_Targowa'], 'read once, by add-point');
  assert.deepEqual(sightsOf(site).map((f) => [f.properties.id, f.properties.asked ?? false]),
    [['kazimierz', true], ['wawel-castle', true], ['market-square', false], ['st-marys', false], ['cloth-hall', false], ['old-synagogue', false]]);

  // the days: written at once, the named places on theirs, the one with no page said so
  const planned = await plan(site, ['--json']);
  assert.equal(planned.code, 0, planned.out + planned.err);
  const days = cfgOf(site).plan.days;
  for (const s of NAMED) {
    const on = days.filter((d) => d.items.some((it) => it.ref?.layer === 'sights' && it.ref.id === s.id && it.asked === true));
    assert.equal(on.length, 1, `${s.name} is on one day, marked as named`);
  }
  assert.match(planned.json.days_for_the_reply, /Kazimierz \(not checked\)/);
  assert.match(planned.json.days_for_the_reply, /Wawel Castle(?! \(not checked\))/);
  for (const d of days) assert.ok(d.items.filter((it) => it.ref?.layer === 'sights').length >= 2, d.title);

  // validate passes and names the sources the map cites: the places' pages and the open data of the stays
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.equal(v.json.sources_for_the_reply, 'Wikipedia, OpenStreetMap');
  const text = await uw(['validate', site, '--signal']);
  assert.match(text.out, /^Sources for the reply, as the map cites them \(no other\): Wikipedia, OpenStreetMap\.$/m);

  // a tourism site's page the turn tried and could not read is no source: refused, and never among the sources
  const tried = await uw(['set', site, 'sights:st-marys', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: `${mock.url}/en/visit/st-marys`, source: 'Visit Kraków' }) });
  assert.equal(tried.code, 2, tried.out + tried.err);
  assert.deepEqual([tried.json.refused, tried.json.why], ['source_not_read', 'HTTP 404: the page is missing or gone']);
  assert.equal((await uw(['validate', site, '--signal', '--json'])).json.sources_for_the_reply, 'Wikipedia, OpenStreetMap');
});

test('a place a pin already is is never listed as not found, and validate fails an entry beside its own pin', async () => {
  const site = 'krakow-first';
  await trip(site);
  read(SQUARE_PAGE.page, SQUARE_PAGE.text);
  const square = { name: 'Main Square', page: SQUARE_PAGE.page };
  assert.equal((await pinBy(site, 'Rynek Główny Kraków', 'market-square', square)).code, 0);
  // the same square by another name: refused, but not listed: its pin is that place
  const again = await pinBy(site, 'Main Market Square, Kraków', 'main-square', square, ['--json']);
  assert.equal(again.code, 2, again.out + again.err);
  assert.equal(again.json.pinned_as, 'sights:market-square');
  assert.equal(cfgOf(site).missing, undefined);
  const text = await pinBy(site, 'Main Market Square, Kraków', 'main-square', square);
  assert.ok(text.err.includes('Not listed as "not found yet": sights:market-square ("Rynek Główny") is that place, on the map already.'), text.err);
  // an entry an earlier version left beside the pin (written by hand here): validate fails it
  const cfg = cfgOf(site);
  cfg.missing = [{ name: 'Main Market Square', layer: 'sights', id: 'main-square', tried: ['OpenStreetMap search (Photon)'],
    place: { osm_id: 'osm-w201133718', names: ['Rynek Główny', 'Main Square'], at: SQUARE.at } }];
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  const v = await uw(['validate', site, '--json']);
  assert.ok(v.json.errors.some((e) => e.path === '$.missing' && e.message === 'listed as not found yet but on the map: Main Market Square'), JSON.stringify(v.json.errors));
  // the same query, pinned under another id with another pick, takes an entry off too
  cfg.missing = [{ name: 'Main Market Square', layer: 'sights', id: 'old-try', query: 'Main Market Square, Kraków', tried: ['OpenStreetMap search (Photon)'] }];
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  const same = await pinBy(site, 'Main Market Square, Kraków', 'market-square', square, ['--pick', '1', '--replace']);
  assert.equal(same.code, 0, same.out + same.err);
  assert.equal(cfgOf(site).missing, undefined);
});

test('the place a "not found" entry keeps is a square, a park or a quarter named with its words; only a pin of it takes the entry off', () => {
  const cand = (type, name, name_en, more = {}) => ({ type, name, name_en, coord: [19.937113, 50.061496], osm_id: 'osm-w1', bbox: [19.9355, 50.0603, 19.9389, 50.0627], ...more });
  const entry = { name: 'Main Market Square', query: 'Main Market Square, Kraków' };
  const place = missedPlace(cand('place=square', 'Rynek Główny', 'Main Square'), entry);
  assert.deepEqual(place, { osm_id: 'osm-w1', names: ['Rynek Główny', 'Main Square'], at: [19.937113, 50.061496], bbox: [19.9355, 50.0603, 19.9389, 50.0627] });
  // a building is another place than the one asked for; a name with a word the entry lacks, or one word only, too
  assert.equal(missedPlace(cand('tourism=hotel', 'Hotel Beta', null), { name: 'Hotel Alpha Beta' }), null);
  assert.equal(missedPlace(cand('leisure=park', 'Park Jordana', null), { name: 'Planty Park' }), null);
  assert.equal(missedPlace(cand('place=square', 'Square', null), { name: 'Old Square' }), null);
  assert.equal(missedPlace(cand('place=square', 'Rynek Główny', 'Main Square'), { name: 'Main Market Square' }).names[1], 'Main Square');
  const m = { name: 'Main Market Square', layer: 'sights', id: 'main-square', query: 'Main Market Square, Kraków', place };
  const pin = (o) => ({ layer: 'sights', id: 'x', names: [], query: null, osm_id: null, coord: null, ...o });
  assert.equal(pinNamesMissing(m, pin({ osm_id: 'osm-w1', names: ['Rynek Główny'] })), true, 'its object');
  assert.equal(pinNamesMissing(m, pin({ osm_id: 'osm-w9', names: ['Rynek Główny'], coord: [19.9366, 50.0612] })), true, 'another object of it, inside it');
  assert.equal(pinNamesMissing(m, pin({ osm_id: 'osm-w9', names: ['Main Square'], coord: [19.9372, 50.0623] })), true, 'by its English name');
  assert.equal(pinNamesMissing(m, pin({ osm_id: 'osm-w8', names: ['Cloth Hall', 'Sukiennice'], coord: [19.937346, 50.061677] })), false, 'another place inside it');
  assert.equal(pinNamesMissing(m, pin({ osm_id: 'osm-w7', names: ['Rynek Główny'], coord: [20.01, 50.07] })), false, 'a square of that name elsewhere');
  assert.equal(pinNamesMissing(m, pin({ names: ['Rynek'], query: 'Main Market Square, Kraków' })), true, 'the same query');
  assert.equal(pinNamesMissing(m, pin({ id: 'main-square' })), true, 'its id');
  assert.equal(pinNamesMissing(m, pin({ id: 'main-square', layer: 'food' })), false, 'its id in another layer');
  assert.equal(pinNamesMissing({ ...m, place: undefined }, pin({ osm_id: 'osm-w1', names: ['Rynek Główny'] })), false, 'no place kept: by its names only');
});

test('validate\'s sources for the reply: who publishes what the map cites, most cited first; the lookups as OpenStreetMap; the person\'s own points none', () => {
  const f = (p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: p });
  const layers = new Map([
    ['stops', [f({ id: 'c', source: 'user-provided coordinates' })]],
    ['stays', [f({ id: 'h1', source: 'OpenStreetMap', source_url: 'https://www.openstreetmap.org/node/1' }), f({ id: 'h2', source: 'OpenStreetMap search (Photon)' }),
      f({ id: 'h3', source: 'Taiwan lodging registers (data.gov.tw 7780 · Taipei 135464)' })]],
    ['sights', [f({ id: 's1', source: 'Wikipedia', source_url: 'https://en.wikipedia.org/wiki/A' }), f({ id: 's2', source: 'Wikipedia', source_url: 'https://en.wikipedia.org/wiki/B' }),
      f({ id: 's3', source_url: 'https://www.castle.example/en/' }), f({ id: 's4', source: 'Wikipedia', source_url: 'https://en.wikipedia.org/wiki/C' })]],
    ['trip', [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { id: 'l', source: 'OSRM / OpenStreetMap', duration_source: 'Rail timetable', duration_source_url: 'https://rail.example/t' } }]],
  ]);
  const cfg = { layers: [...layers.keys()].map((id) => ({ id })), plan: { days: [{ items: [{ text: 'Base', ref: { layer: 'stays', id: 'h1' }, url: 'https://www.openstreetmap.org/node/1', source: 'OpenStreetMap' },
    { text: 'A market no lookup pinned', url: 'https://market.example/', source: 'Market hall' }] }] } };
  assert.deepEqual(sourcesCited(cfg, layers), ['OpenStreetMap', 'Wikipedia', 'Taiwan lodging registers', 'castle.example', 'Rail timetable', 'Market hall']);
  assert.deepEqual(sourcesCited({ layers: [] }, new Map()), []);
});

test('the trip guide pins the named places first, and its reply takes its days, gaps and sources from uw plan and uw validate, never asking the person to add a place', () => {
  const md = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8').replace(/\s+/g, ' ');
  const oneBase = md.slice(md.indexOf('## One base'), md.indexOf('## Phase B'));
  assert.match(oneBase, / 3\. \*\*The places the message names\*\*, pinned first, each with `"asked":true` \(Phase B step 1\); only those\. 4\. \*\*Places by area\*\*/);
  assert.doesNotMatch(oneBase, /one the person named also/, 'no longer a parenthetical');
  assert.match(md, /The places the message names come first, each with `"asked":true` in its props: `uw plan` keeps it on its day as the person gave it, marked not checked until its own page is read \(never a place you chose\)\./);
  const reply = md.slice(md.indexOf('## Reply'));
  assert.match(reply, /say plainly what is missing, as the last `uw plan` and `uw validate` name it \("<day> has nothing to see yet", "<day> has one place to see", "no days yet: <day> needs one more place", "<place> is not checked yet", "<place> you named is on no day"\), never with a cause they do not give\. Never ask the person to add a place: say which day is short and offer to add one\./);
  assert.match(reply, /6\. `Sources:` in one line, as `uw validate` lists them \("Sources for the reply"\): who publishes what the map cites \(e\.g\. "OpenStreetMap, Wikipedia, the national park's site", a lodging register, a timetable\), no other\./);
  assert.match(reply, /7\. `Unverified:` prices and availability \(never checked\), train times not sourced, anything `uw validate` lists as not found yet, handoff unknowns\./);
  assert.match(md, /No such day yet \(no plan\): say which day is short as `uw plan` names it, and offer to add a place there; never ask the person to add one\./);
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(skill, /sources by publisher \(OpenStreetMap, Wikipedia\) in one line, as `uw validate` lists them;/);
});
