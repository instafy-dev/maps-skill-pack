// A 3-day Seville map pinned Plaza de España twice (a second add-point under a new id only warned "the same OSM object
// is already in this layer"), on Wednesday and Thursday; María Luisa Park cited an address that led to a photo (`uw
// cite --grep` said "no line matches" and exited 0); two sights cited pages the turn never read; and the turn replied
// with validate's "2 places cite one page" standing, whose fix (cite each one's own page) could not clear one place
// pinned twice. Now:
//  - add-point refuses a place already pinned in the layer (exit 2, naming that pin; nothing written); --replace
//    replaces that pin and keeps its id;
//  - a place pinned again under its own id after the days were planned: its items in the days link its new page;
//  - uw cite --grep exits 2 when no line matches, or when the address is not a page (an image, also one a page's
//    address led to); --grep is accent-insensitive;
//  - uw validate checks every sight's page against what uw cite read: one that does not name its place (or is not a
//    page) fails while the turn has time; one no uw cite read fails in the turn that planned the days, with the
//    commands that read it; one place pinned twice is its own error, whose fix removes the later pin.
// Offline: the place search and the web pages are a local mock in this file; pages at https:// addresses (the plan's
// links must be https) are put in the shared cache as uw cite keeps what it read.
// Run: node --test tests/one-place-one-pin.test.mjs
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
const SCRIPTS = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts');
const UW = path.join(SCRIPTS, 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-one-pin-'));
const CACHE = path.join(tmp, 'cache');
// what uw cite keeps, written the way it writes it (the shared cache of this test's own folder)
delete process.env.UW_NO_CACHE;
process.env.UW_CACHE = CACHE;
const { rememberCited } = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'cmd-cite.mjs')).href);

const CITY = [-5.99534, 37.38863];
const SEV = { city: 'Sevilla', county: 'Sevilla', state: 'Andalucía', country: 'España', countrycode: 'ES', district: 'Distrito Sur' };
const SQUARE = { type: 'Feature', geometry: { type: 'Point', coordinates: [-5.98694, 37.376974] },
  properties: { osm_type: 'R', osm_id: 1866166, osm_key: 'place', osm_value: 'square', name: 'Plaza de España', ...SEV } };
const ALCAZAR = { type: 'Feature', geometry: { type: 'Point', coordinates: [-5.990183, 37.383211] },
  properties: { osm_type: 'W', osm_id: 22747187, osm_key: 'historic', osm_value: 'castle', name: 'Real Alcázar de Sevilla', ...SEV } };
const ANSWERS = { 'Plaza de España, Seville': [SQUARE], 'Plaza de España': [SQUARE], 'Alcázar, Seville': [ALCAZAR] };
// a JPEG's first bytes, then bytes that are no text
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(400, 0x9c)]);
const PAGES = {
  '/en/city-routes/': '<html><head><title>City routes | Visita Sevilla</title></head><body><h1>City routes</h1><p>Route of the water</p><p>Route of the kings</p></body></html>',
  '/en/plaza-de-espana': '<html><head><title>Plaza de España | Visita Sevilla</title></head><body><h1>Plaza de España</h1><p>Framed in the Maria Luisa Park.</p></body></html>',
};

let mock;
before(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n'); return; }
    if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[u.pathname]); return; }
    // a park's page address that leads to its photo, and the photo itself (served with no type too)
    if (u.pathname === '/en/parque-de-maria-luisa') { res.writeHead(302, { location: '/wp-content/uploads/parque-de-maria-luisa.jpg' }); res.end(); return; }
    if (u.pathname === '/wp-content/uploads/parque-de-maria-luisa.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(PHOTO); return; }
    if (u.pathname === '/files/untyped') { res.writeHead(200); res.end(PHOTO); return; }
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

// `clock`: a host turn's clock (when it started and its deadline); none: the pack's own
const uw = (args, { input = null, clock = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: CACHE, UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_ALLOW_LOCAL: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  if (clock) Object.assign(env, { INSTAFY_TURN_STARTED_AT: clock.started, INSTAFY_TURN_DEADLINE: clock.deadline });
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
/** A host turn of ten minutes with `usedS` seconds used (the pack keeps two minutes of it for the reply). */
const hostClock = (usedS) => ({ started: new Date(Date.now() - usedS * 1000).toISOString(), deadline: new Date(Date.now() + (600 - usedS) * 1000).toISOString() });
const newTrip = async (site) => {
  assert.equal((await uw(['new', site, '--title', '3 days in Seville', '--center', CITY.join(','), '--zoom', '13', '--expect', 'Seville:3'])).code, 0);
  assert.equal((await uw(['add-point', site, '--layer', 'stops', '--at', CITY.join(','), '--name', 'Seville', '--kind', 'city', '--id', 'seville', '--props', '{"nights":3}'])).code, 0);
};
const page = (url) => ({ stop: 'seville', source_url: url, source: new URL(url).hostname.replace(/^www\./, '') });
const pinAt = (site, s) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'], { input: JSON.stringify(page(s.page)) });
const pinSquare = (site, id, url, more = [], opts = {}) => uw(['add-point', site, '--layer', 'sights', '--query', 'Plaza de España, Seville', '--near', CITY.join(','), '--id', id, ...more, '--props-file', '-', '--json'],
  { input: JSON.stringify({ ...page(url), ...(opts.why ? { why: opts.why } : {}) }) });
const plan = (site, opts = {}) => uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-03', '--sights', 'sights', '--force'], opts);
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const sightsOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', 'sights.geojson'), 'utf8')).features;
const itemsOf = (site, id) => cfgOf(site).plan.days.flatMap((d) => d.items || []).filter((it) => it.ref?.id === id);
const daysOf = (site) => cfgOf(site).plan.days.map((d) => (d.items || []).map((it) => it.ref?.id));
/** uw cite read this https page (or found it was not one) a moment ago */
const read = (url, text, more = {}) => rememberCited([url], { url, title: '', retrieved_at: new Date().toISOString(), text, ...more });

const OWN = 'https://www.visitasevilla.es/en/plaza-de-espana';
const ROUTES = 'https://www.visitasevilla.es/en/city-routes/';

test('add-point: the same place again under another id is refused, naming its pin; --replace replaces that pin and keeps its id', async () => {
  const site = 'twice';
  await newTrip(site);
  const first = await pinSquare(site, 'plaza-espana', OWN, [], { why: 'See the 1929 square.' });
  assert.equal(first.code, 0, first.out + first.err);
  // a third day short of places: the same square again under a new id
  const again = await pinSquare(site, 'espanola', OWN);
  assert.equal(again.code, 2, again.out + again.err);
  assert.deepEqual(again.json, { ok: false, refused: 'already_pinned', query: 'Plaza de España, Seville', layer: 'sights', id: 'espanola',
    pinned: { id: 'plaza-espana', name: 'Plaza de España' }, osm_id: 'osm-r1866166' });
  assert.match(again.err, /^REFUSED: "Plaza de España" \[place=square\] \(osm-r1866166\) is already pinned in this layer as sights:plaza-espana: one place, one pin\.$/m);
  assert.match(again.err, /^Nothing was written\. A day that needs another place takes a different place, from its own page\.$/m);
  assert.ok(again.err.includes('To change that pin (its page, its reason): uw set twice sights:plaza-espana --props-file - with'), again.err);
  assert.ok(again.err.includes('the same command with --replace (it replaces sights:plaza-espana and keeps that id'), again.err);
  assert.deepEqual(sightsOf(site).map((f) => f.properties.id), ['plaza-espana'], 'nothing was written');
  assert.equal(cfgOf(site).missing, undefined, 'it is on the map: never "not found yet"');

  // --replace: that pin, its id kept, with what this command found
  const swap = await pinSquare(site, 'espanola', OWN, ['--replace'], { why: 'Walk the tiled alcoves.' });
  assert.equal(swap.code, 0, swap.out + swap.err);
  assert.equal(swap.json.id, 'plaza-espana');
  assert.equal(swap.json.replaced, true);
  assert.deepEqual(sightsOf(site).map((f) => [f.properties.id, f.properties.why]), [['plaza-espana', 'Walk the tiled alcoves.']]);

  // its own id again is a replace, as it always was; another layer is another list (a market can be a sight and food)
  assert.equal((await pinSquare(site, 'plaza-espana', OWN)).code, 0);
  const food = await uw(['add-point', site, '--layer', 'food', '--query', 'Plaza de España, Seville', '--near', CITY.join(','), '--id', 'plaza-food']);
  assert.equal(food.code, 0, food.err);
  assert.deepEqual(sightsOf(site).map((f) => f.properties.id), ['plaza-espana']);
});

test('add-point again under a place\'s own id after the days were planned: its items in the days link its new page, the days stay', async () => {
  const site = 'again';
  await newTrip(site);
  assert.equal((await pinSquare(site, 'plaza-espana', ROUTES)).code, 0);
  assert.equal((await pinAt(site, { id: 'cathedral', name: 'Cathedral of Seville', at: [-5.993141, 37.385915], page: 'https://www.catedraldesevilla.es/en/' })).code, 0);
  assert.equal((await plan(site)).code, 0);
  assert.deepEqual(itemsOf(site, 'plaza-espana').map((it) => [it.url, it.source]), [[ROUTES, 'visitasevilla.es']]);
  const days = daysOf(site);
  // pinned again under its id with its own page
  const r = await uw(['add-point', site, '--layer', 'sights', '--query', 'Plaza de España, Seville', '--near', CITY.join(','), '--id', 'plaza-espana', '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'seville', source_url: OWN, source: 'Visita Sevilla' }) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.replaced, true);
  assert.equal(r.json.day_items, 1);
  assert.deepEqual(itemsOf(site, 'plaza-espana').map((it) => [it.url, it.source]), [[OWN, 'Visita Sevilla']], 'the day links the page it cites now');
  assert.deepEqual(daysOf(site), days, 'no new plan: the days are as they were');
  // the text says so
  const t = await uw(['add-point', site, '--layer', 'sights', '--query', 'Plaza de España, Seville', '--near', CITY.join(','), '--id', 'plaza-espana', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'seville', source_url: ROUTES, source: 'Visita Sevilla' }) });
  assert.match(t.out, /^Its item in the plan's days links its page now; the days are as they were\.$/m);
  assert.deepEqual(itemsOf(site, 'plaza-espana').map((it) => it.url), [ROUTES]);
});

test('uw cite --grep exits 2 when no line matches, and an address that is not a page (an image) exits 2 too', async () => {
  const site = 'cites';
  assert.equal((await uw(['new', site, '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  // the page does not say it: not the source for it
  const none = await uw(['cite', `${mock.url}/en/city-routes/`, '--grep', 'Plaza de España']);
  assert.equal(none.code, 2, none.out + none.err);
  assert.match(none.out, /^no line matches \/Plaza de España\/i: this page does not say it, so it is not the source for it\. Cite a page that does/m);
  const noneJson = await uw(['cite', `${mock.url}/en/city-routes/`, '--grep', 'Plaza de España', '--json']);
  assert.equal(noneJson.code, 2);
  assert.equal(noneJson.json.ok, false);
  assert.equal(noneJson.json.matches, 0);
  // accents aside, either way: "María Luisa" finds "Maria Luisa Park", and "Plaza de Espana" finds "Plaza de España"
  const accents = await uw(['cite', `${mock.url}/en/plaza-de-espana`, '--grep', 'María Luisa', '--json']);
  assert.equal(accents.code, 0, accents.out + accents.err);
  assert.equal(accents.json.excerpt, 'Framed in the Maria Luisa Park.');
  const plainGrep = await uw(['cite', `${mock.url}/en/plaza-de-espana`, '--grep', 'Plaza de Espana', '--json']);
  assert.equal(plainGrep.code, 0, plainGrep.out + plainGrep.err);
  assert.equal(plainGrep.json.excerpt, 'Plaza de España');
  // a park's page address that leads to its photo: no text, not a page, with --grep or without
  for (const extra of [['--grep', 'María Luisa'], []]) {
    const photo = await uw(['cite', `${mock.url}/en/parque-de-maria-luisa`, ...extra]);
    assert.equal(photo.code, 2, photo.out + photo.err);
    assert.ok(photo.out.includes(`not a page: ${mock.url}/en/parque-de-maria-luisa led to an image (image/jpeg): there is no text on it to read, so it is not the source of anything.`), photo.out);
    assert.doesNotMatch(photo.out, /matching line|no line matches/);
  }
  const photoJson = await uw(['cite', `${mock.url}/en/parque-de-maria-luisa`, '--grep', 'María Luisa', '--json']);
  assert.deepEqual([photoJson.json.ok, photoJson.json.not_page, photoJson.json.matches], [false, 'an image (image/jpeg)', 0]);
  // a file served with no type is judged by its bytes
  const untyped = await uw(['cite', `${mock.url}/files/untyped`]);
  assert.equal(untyped.code, 2, untyped.out);
  assert.match(untyped.out, /^not a page: it is a file that is not text: there is no text on it to read/m);
  // a place that cites the photo's address is told at once: it is no page
  assert.equal((await uw(['add-point', site, '--layer', 'sights', '--at', '-5.988794,37.374771', '--name', 'Maria Luisa Park', '--id', 'maria-luisa'])).code, 0);
  const set = await uw(['set', site, 'sights:maria-luisa', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: `${mock.url}/en/parque-de-maria-luisa`, source: 'Visita Sevilla' }) });
  assert.equal(set.code, 0, set.out + set.err);
  assert.deepEqual(set.json.source_not_named, { url: `${mock.url}/en/parque-de-maria-luisa`, name: 'Maria Luisa Park', not_page: 'an image (image/jpeg)' });
  assert.ok(set.err.includes(`warning: ${mock.url}/en/parque-de-maria-luisa (read by uw cite) is an image (image/jpeg), not a page that names "Maria Luisa Park": it is not this place's source.`), set.err);
});

const SIGHTS = [
  { id: 'alcazar', name: 'Alcázar of Seville', at: [-5.990183, 37.383211], page: 'https://www.alcazarsevilla.org/en/' },
  { id: 'maria-luisa', name: 'Maria Luisa Park', at: [-5.988794, 37.374771], page: 'https://www.visitasevilla.es/en/parque-de-maria-luisa' },
  { id: 'murillo', name: 'Casa de Murillo', at: [-5.989081, 37.385717], page: ROUTES },
  { id: 'pilatos', name: 'Casa de Pilatos', at: [-5.987249, 37.390239], page: 'https://www.fundacionmedinaceli.org/en/casa-de-pilatos' },
  { id: 'cathedral', name: 'Cathedral of Seville', at: [-5.993141, 37.385915], page: 'https://www.catedraldesevilla.es/en/' },
  { id: 'indies', name: 'General Archive of the Indies', at: [-5.992657, 37.384365], page: 'https://www.cultura.gob.es/archivo-indias/' },
];
/** What uw cite read for SIGHTS: two pages that name their place, a photo, a routes page; the palace's page unread. */
const readSights = () => {
  read(SIGHTS[0].page, 'Real Alcázar de Sevilla\nThe Alcázar of Seville is a royal palace.');
  read(SIGHTS[1].page, '', { not_page: 'an image (image/jpeg)' });
  read(ROUTES, 'City routes\nRoute of the water\nRoute of the kings');
  read(SIGHTS[4].page, 'Cathedral of Seville\nThe Gothic cathedral.');
  read(SIGHTS[5].page, 'General Archive of the Indies\nDocuments of the Spanish empire.');
};

test('validate: a sight whose page does not name it, or that no uw cite read, fails while the turn has time; the fix\'s commands clear it', async () => {
  const site = 'sources';
  await newTrip(site);
  readSights();
  for (const s of SIGHTS) assert.equal((await pinAt(site, s)).code, 0);
  assert.equal((await plan(site)).code, 0);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1, v.out);
  const own = v.json.errors.filter((e) => e.path === '$.plan.sights');
  assert.deepEqual(own.map((e) => e.message), [
    `2 places cite a page that does not name them: Maria Luisa Park (sights:maria-luisa: ${SIGHTS[1].page} is an image (image/jpeg), not a page), Casa de Murillo (sights:murillo: ${ROUTES})`,
    `1 place cites a page no uw cite read: Casa de Pilatos (sights:pilatos: ${SIGHTS[3].page})`,
  ]);
  assert.equal(own[0].fix, 'cite each place\'s own page (its own site, else its Wikipedia article): uw cite <that page> --grep "<its name>", then uw set sources <layer>:<id> --props-file - with {"source_url":"<that page>","source":"<site>"}; it gives the place\'s item in the days that page too, so the days stay as they are');
  assert.ok(own[1].fix.startsWith(`read it: uw cite "${SIGHTS[3].page}" --grep "Casa de Pilatos"; then validate again: a page that names its place passes. A page that does not, or that cannot be read, is not its source: cite each place's own page`), own[1].fix);
  assert.ok(own[1].fix.includes('then uw set sources sights:pilatos --props-file -'), own[1].fix);
  // as the fixes say: the palace's page read (it names it), the park and the house on their own pages
  read(SIGHTS[3].page, 'Casa de Pilatos\nAndalusian palace of the Dukes of Medinaceli.');
  const park = 'https://en.wikipedia.org/wiki/Mar%C3%ADa_Luisa_Park', house = 'https://en.wikipedia.org/wiki/Casa_de_Murillo';
  read(park, 'María Luisa Park\nA public park along the Guadalquivir.');
  read(house, 'Casa de Murillo\nThe house where the painter lived.');
  for (const [id, url] of [['maria-luisa', park], ['murillo', house]])
    assert.equal((await uw(['set', site, `sights:${id}`, '--props-file', '-'], { input: JSON.stringify({ source_url: url, source: 'Wikipedia' }) })).code, 0);
  const ok = await uw(['validate', site, '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.json?.errors ?? ok.out, null, 1));
  assert.deepEqual(ok.json.warnings.filter((w) => w.path === '$.plan.sights'), []);
});

test('validate: with too little time a page that does not name its place is a warning; a later turn judges what was read, never what was not', async () => {
  const site = 'sources-later';
  await newTrip(site);
  readSights();
  // the palace's page: one nobody read (the test above read the one it cites)
  for (const s of SIGHTS) assert.equal((await pinAt(site, s.id === 'pilatos' ? { ...s, page: 'https://www.fundacionmedinaceli.org/es/casa-de-pilatos' } : s)).code, 0);
  const turn1 = hostClock(450);
  assert.equal((await plan(site, { clock: turn1 })).code, 0);
  const late = await uw(['validate', site, '--json'], { clock: turn1 });
  assert.deepEqual(late.json.errors.filter((e) => e.path === '$.plan.sights'), []);
  const warned = late.json.warnings.filter((w) => w.path === '$.plan.sights');
  assert.deepEqual(warned.map((w) => w.message.split(':')[0]), ['2 places cite a page that does not name them', '1 place cites a page no uw cite read']);
  assert.deepEqual(warned.map((w) => w.fix), [
    'too little time is left to cite their own pages in this turn; the reply names these places as not checked on a page of their own',
    'too little time is left to read their pages in this turn; the reply names these places as not checked on their page',
  ]);
  // the next turn: a page read that does not name its place still fails; one nobody read is not judged
  const turn2 = hostClock(0);
  const v = await uw(['validate', site, '--json'], { clock: turn2 });
  const own = [...v.json.errors, ...v.json.warnings].filter((e) => e.path === '$.plan.sights');
  assert.deepEqual(own.map((e) => `${e.level} ${e.message.split(':')[0]}`), ['error 2 places cite a page that does not name them']);
});

test('a page that names a place as it was looked up names it: add-point keeps that name, and validate judges with it', async () => {
  const site = 'asked';
  await newTrip(site);
  const visit = 'https://www.alcazarsevilla.org/en/visit';
  read(visit, 'Visit the Alcázar\nOpen every day of the year.');
  const a = await uw(['add-point', site, '--layer', 'sights', '--query', 'Alcázar, Seville', '--near', CITY.join(','), '--id', 'alcazar', '--props-file', '-', '--json'],
    { input: JSON.stringify(page(visit)) });
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(a.json.source_not_named, undefined, 'the page names it as it was asked for');
  assert.deepEqual(sightsOf(site).map((f) => [f.properties.name, f.properties.looked_up_as]), [['Real Alcázar de Sevilla', 'Alcázar']]);
  read(SIGHTS[4].page, 'Cathedral of Seville');
  assert.equal((await pinAt(site, SIGHTS[4])).code, 0);
  assert.equal((await plan(site)).code, 0);
  const v = await uw(['validate', site, '--json']);
  assert.deepEqual(v.json.errors.filter((e) => e.path === '$.plan.sights'), []);
  // a name the place is not looked up by is no name: the same page for the cathedral does not name it
  const s = await uw(['set', site, 'sights:cathedral', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: visit, source: 'Real Alcázar' }) });
  assert.deepEqual(s.json.source_not_named, { url: visit, name: 'Cathedral of Seville' });
});

test('validate: one place pinned twice is its own error, whose fix removes the later pin (not "places cite one page")', async () => {
  const site = 'dupe';
  await newTrip(site);
  read(OWN, 'Plaza de España\nFramed in the Maria Luisa Park.');
  read(SIGHTS[0].page, 'The Alcázar of Seville is a royal palace.');
  read(SIGHTS[4].page, 'Cathedral of Seville');
  assert.equal((await pinSquare(site, 'plaza-espana', OWN)).code, 0);
  for (const s of [SIGHTS[0], SIGHTS[4]]) assert.equal((await pinAt(site, s)).code, 0);
  // as 0.1.29 left a map: the square pinned again under a new id
  const file = path.join(tmp, site, 'data', 'sights.geojson');
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  fc.features.push({ ...fc.features[0], properties: { ...fc.features[0].properties, id: 'espanola' } });
  fs.writeFileSync(file, JSON.stringify(fc));
  assert.equal((await plan(site)).code, 0);
  assert.ok(itemsOf(site, 'espanola').length, 'the second pin is on a day of its own');
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1, v.out);
  const twice = v.json.errors.filter((e) => /pinned/.test(e.message));
  assert.deepEqual(twice.map((e) => [e.file, e.message]), [['data/sights.geojson', 'one place is pinned 2 times: Plaza de España (sights:plaza-espana, sights:espanola)']]);
  assert.equal(twice[0].fix, 'one place, one pin: remove the later pin: uw set dupe sights:espanola --remove; then the days: uw plan dupe … --force in the turn that planned them, else remove its item from its day and reword that day\'s text; a day it leaves short takes another place, from its own page');
  assert.deepEqual(v.json.errors.filter((e) => /cite one page/.test(e.message)), [], 'one place is not "places that cite one page"');
  // as the fix says
  assert.equal((await uw(['set', site, 'sights:espanola', '--remove'])).code, 0);
  assert.equal((await plan(site)).code, 0);
  const ok = await uw(['validate', site, '--json']);
  assert.deepEqual(ok.json.errors.filter((e) => /pinned|cite/.test(e.message)), []);
});
