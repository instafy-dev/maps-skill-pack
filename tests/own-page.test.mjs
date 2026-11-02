// A 3-day Seville map pinned Plaza de España and Casa de Murillo with a city routes page as their source: the page
// listed three themed routes and named neither, `uw validate` only warned (two places shared that page), and the reply
// said "Checked … Visita Sevilla". Its first turn had pinned its sights with no page; validate's fix asked for places "a
// page you read names", named no reader, and the turn asked for the browser (three turns for one map). Now:
//  - places that cite one page fail `uw validate` while the turn has time to cite their own;
//  - `uw set` and `uw add-point` say at once when a source_url is a page `uw cite` read that does not name the place
//    (one place alone on such a page too), from what uw cite kept: no second request;
//  - a day with nothing to see names the reader: uw cite on each place's own page in this turn, never a browser card.
// Offline: the place search and the web pages are a local mock in this file.
// Run: node --test tests/own-page.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NO_WIKIPEDIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UW = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-own-page-'));

const CITY = [-5.99534, 37.38863];
const SEV = { city: 'Sevilla', county: 'Sevilla', state: 'Andalucía', country: 'España', countrycode: 'ES', district: 'Distrito Sur' };
const ANSWERS = {
  'Plaza de España, Seville': [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-5.98694, 37.376974] },
    properties: { osm_type: 'R', osm_id: 1866166, osm_key: 'place', osm_value: 'square', name: 'Plaza de España', ...SEV } }],
};
// the pages: a routes page that names no place (as the browser read it), and the square's own page; accents aside
const PAGES = {
  '/en/city-routes/': '<html><head><title>City routes | Visita Sevilla</title></head><body><h1>City routes</h1><p>Route of the water</p><p>Route of the kings</p><p>Route of the arts</p></body></html>',
  '/en/plaza-de-espana': '<html><head><title>Plaza de Espana | Visita Sevilla</title></head><body><h1>Plaza de Espana</h1><p>Built for the 1929 exposition.</p></body></html>',
};

let mock;
const hits = [];
before(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname);
    if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n'); return; }
    if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[u.pathname]); return; }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'FeatureCollection', features: u.searchParams.getAll('osm_tag').length ? [] : ANSWERS[u.searchParams.get('q')] || [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mock = { server, url: `http://127.0.0.1:${server.address().port}` };
});
after(() => {
  mock?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// the shared cache is on (what uw cite read is kept there), in this test's own folder; the mock web is on 127.0.0.1,
// which uw cite reads only with UW_ALLOW_LOCAL=1
const uw = (args, { input = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_ALLOW_LOCAL: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const newTrip = async (site) => {
  assert.equal((await uw(['new', site, '--title', '3 days in Seville', '--center', CITY.join(','), '--zoom', '13', '--expect', 'Seville:3'])).code, 0);
  assert.equal((await uw(['add-point', site, '--layer', 'stops', '--at', CITY.join(','), '--name', 'Seville', '--kind', 'city', '--id', 'seville', '--props', '{"nights":3}'])).code, 0);
};
const pin = (site, s) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'],
  { input: JSON.stringify({ stop: 'seville', ...(s.page ? { source_url: s.page, source: new URL(s.page).hostname.replace(/^www\./, '') } : {}) }) });
const plan = (site) => uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-02', '--sights', 'sights', '--force']);

const ROUTES = 'https://www.visitasevilla.es/en/city-routes/';
const SIGHTS = [
  { id: 'cathedral', name: 'Cathedral of Seville', at: [-5.993141, 37.385915], page: 'https://www.catedraldesevilla.es/en/' },
  { id: 'alcazar', name: 'Alcázar of Seville', at: [-5.990183, 37.383211], page: 'https://www.alcazarsevilla.org/en/' },
  { id: 'plaza-espana', name: 'Plaza de España', at: [-5.98694, 37.376974], page: ROUTES },
  { id: 'murillo', name: 'Casa de Murillo', at: [-5.989081, 37.385717], page: ROUTES },
  { id: 'pilatos', name: 'Casa de Pilatos', at: [-5.987249, 37.390239], page: 'https://www.fundacionmedinaceli.org/en/casa-de-pilatos' },
  { id: 'indies', name: 'General Archive of the Indies', at: [-5.992657, 37.384365], page: 'https://www.cultura.gob.es/archivo-indias/' },
];

test('validate: two places that cite a page naming neither fail while the turn has time; each with its own page passes', async () => {
  const site = 'own';
  await newTrip(site);
  for (const s of SIGHTS) assert.equal((await pin(site, s)).code, 0);
  assert.equal((await plan(site)).code, 0);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1, v.out);
  const shared = v.json.errors.filter((e) => e.path === '$.plan.sights');
  assert.deepEqual(shared.map((e) => e.message), [`2 places cite one page (${ROUTES}): Plaza de España, Casa de Murillo. A page about a whole city or a list of places says which are worth it; it is not their source`]);
  assert.equal(shared[0].fix, 'cite each place\'s own page (its own site, else its Wikipedia article): uw cite <that page> --grep "<its name>", then uw set own <layer>:<id> --props-file - with {"source_url":"<that page>","source":"<site>"}, then uw plan … --force');
  // each with its own page
  for (const [id, page] of [['plaza-espana', 'https://en.wikipedia.org/wiki/Plaza_de_Espa%C3%B1a,_Seville'], ['murillo', 'https://en.wikipedia.org/wiki/Casa_de_Murillo']])
    assert.equal((await uw(['set', site, `sights:${id}`, '--props-file', '-'], { input: JSON.stringify({ source_url: page, source: 'Wikipedia' }) })).code, 0);
  assert.equal((await plan(site)).code, 0);
  const ok = await uw(['validate', site, '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.json?.errors ?? ok.out, null, 1));
  assert.deepEqual(ok.json.warnings.filter((w) => w.path === '$.plan.sights'), []);
});

test('add-point and set say at once when a page uw cite read does not name the place, one place alone on it too; no second request', async () => {
  const site = 'cited';
  assert.equal((await uw(['new', site, '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  const routes = `${mock.url}/en/city-routes/`, own = `${mock.url}/en/plaza-de-espana`;
  const c = await uw(['cite', routes, '--grep', 'Plaza de España']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /no line matches/);
  const pages = () => hits.filter((p) => p.startsWith('/en/')).length;
  const read = pages();

  // add-point with that page as its source: pinned, and said at once
  const a = await uw(['add-point', site, '--layer', 'sights', '--query', 'Plaza de España, Seville', '--near', CITY.join(','), '--id', 'plaza-espana', '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'seville', source_url: routes, source: 'Visita Sevilla' }) });
  assert.equal(a.code, 0, a.out + a.err);
  assert.deepEqual(a.json.source_not_named, { url: routes, name: 'Plaza de España' });
  assert.ok(a.err.includes(`warning: ${routes} (read by uw cite) does not name "Plaza de España": it is not this place's source. Cite the place's own page (its own site, else its Wikipedia article): uw cite <that page> --grep "Plaza de España", then uw set cited sights:plaza-espana --props-file - with {"source_url":"<that page>","source":"<site>"}`), a.err);
  // set: one place alone on the page is caught too
  assert.equal((await uw(['add-point', site, '--layer', 'sights', '--at', '-5.987249,37.390239', '--name', 'Casa de Pilatos', '--id', 'pilatos'])).code, 0);
  const s = await uw(['set', site, 'sights:pilatos', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: routes, source: 'Visita Sevilla' }) });
  assert.equal(s.code, 0, s.out + s.err);
  assert.deepEqual(s.json.source_not_named, { url: routes, name: 'Casa de Pilatos' });
  assert.match(s.err, /does not name "Casa de Pilatos": it is not this place's source\. .* then uw set cited sights:pilatos --props-file -/);
  assert.equal(pages(), read, 'no page was read again');

  // the place's own page, which names it (accents aside): nothing said
  assert.equal((await uw(['cite', own, '--grep', 'Plaza'])).code, 0);
  const fixed = await uw(['set', site, 'sights:plaza-espana', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: own, source: 'Visita Sevilla' }) });
  assert.equal(fixed.code, 0, fixed.out + fixed.err);
  assert.equal(fixed.json.source_not_named, undefined);
  assert.doesNotMatch(fixed.err, /does not name/);
  // a page uw cite did not read is not judged, and not read
  const before = hits.length;
  const unread = await uw(['set', site, 'sights:pilatos', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: `${mock.url}/en/casa-de-pilatos`, source: 'Visita Sevilla' }) });
  assert.equal(unread.code, 0);
  assert.equal(unread.json.source_not_named, undefined);
  assert.equal(hits.length, before, 'set makes no request');
});

test('validate: a day with nothing to see names the reader, uw cite on each place\'s own page in this turn, never a browser card', async () => {
  const site = 'bare';
  await newTrip(site);
  // pinned with no page, as the first turn did
  for (const s of SIGHTS.slice(0, 5)) assert.equal((await pin(site, { ...s, page: null })).code, 0);
  assert.equal((await plan(site)).code, 0);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1, v.out);
  const e = v.json.errors.find((x) => x.path === '$.plan.days');
  assert.equal(e.message, '3 of 3 full days have nothing to see (no sourced place): Mon 2 Nov · Seville, Tue 3 Nov · Seville, Wed 4 Nov · Seville');
  assert.equal(e.fix, 'uw plan bare … --sights sights --force spreads the places already pinned over every day, the arrival day too: run it first when a stop has as many places as days. '
    + 'Else cite 2-3 places for each of those days in this turn, each from its own page (its own site, else its Wikipedia article): uw cite <page> --grep "<its name>", never a browser card; '
    + 'then uw add-point bare --layer sights … with {"stop":…,"source_url":…}; the 5 places pinned with no page: uw set bare <layer>:<id> --props-file - with {"source_url":…,"source":…} '
    + '(reference/itinerary.md Phase B step 1), then run it; a place the lookup cannot pin goes on its day as {"text": "<name>", "url": "<its page>", "source": "<site>"}');
  assert.doesNotMatch(JSON.stringify(v.json.errors), /a page you read names/);
});
