// A 3-day Seville map pinned Plaza de España and Casa de Murillo with a city routes page as their source: the page
// listed three themed routes and named neither, `uw validate` only warned (two places shared that page), and the reply
// said "Checked … Visita Sevilla". Its first turn had pinned its sights with no page; validate's fix asked for places "a
// page you read names", named no reader, and the turn asked for the browser (three turns for one map). Now:
//  - places that cite one page fail `uw validate` while the turn has time to cite their own, a later turn's too; the
//    fix ends at `uw set`, which gives each place's own page to its items in the days, so the days the person changed
//    stay (a new plan groups them by area again);
//  - `uw set` and `uw add-point` refuse a source_url that is a page `uw cite` read that does not name the place (one
//    place alone on such a page too), or a page another place cites, from what uw cite kept, where and when validate
//    fails it (a trip's places to see, an area to stay in that says why, while the turn has time to cite): no second
//    request ("cite its own page"; nothing added or changed); one it did not read is refused too; a map an earlier pack
//    left with places on one page still validates, names them, and takes a note;
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_WIKIPEDIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UW = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-own-page-'));
// what uw cite read, kept the way it keeps it (this test's own shared cache): a sight's page is one uw cite read
delete process.env.UW_NO_CACHE;
process.env.UW_CACHE = path.join(tmp, 'cache');
const { rememberCited } = await import(pathToFileURL(path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'lib', 'cmd-cite.mjs')).href);
const read = (url, text) => rememberCited([url], { url, title: '', retrieved_at: new Date().toISOString(), text });

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
// `clock`: a host turn's clock (when it started and its deadline); none: the pack's own
const uw = (args, { input = null, clock = null, env: extra = {} } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_ALLOW_LOCAL: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  if (clock) Object.assign(env, { INSTAFY_TURN_STARTED_AT: clock.started, INSTAFY_TURN_DEADLINE: clock.deadline });
  Object.assign(env, extra);
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
const pin = (site, s, env = {}) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'],
  { input: JSON.stringify({ stop: 'seville', ...(s.page ? { source_url: s.page, source: new URL(s.page).hostname.replace(/^www\./, '') } : {}) }), env });
/** A place a `uw handoff --apply` step pins (its researcher's page, which the handoff's own source check judges), as
 *  an earlier pack's turn pinned any: the places on one page below are a map's state from before */
const STEP = { UW_HANDOFF_STEP: '1' };
const pinAsBefore = (site, s) => pin(site, s, s.page === ROUTES ? STEP : {});
const plan = (site, opts = {}) => uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-02', '--sights', 'sights', '--force'], opts);
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
/** A host turn of ten minutes with `usedS` seconds used (the pack keeps two minutes of it for the reply). */
const hostClock = (usedS) => ({ started: new Date(Date.now() - usedS * 1000).toISOString(), deadline: new Date(Date.now() + (600 - usedS) * 1000).toISOString() });
/** Each day's items, as layer:id → [url, source], and which day each place is on. */
const itemOf = (site, id) => cfgOf(site).plan.days.flatMap((d) => d.items || []).find((it) => it.ref?.id === id);
const dayOf = (site, id) => cfgOf(site).plan.days.findIndex((d) => (d.items || []).some((it) => it.ref?.id === id));

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
  // the pages this turn read: each sight's own (it names it), and the routes page, which names none
  for (const s of SIGHTS) read(s.page, s.page === ROUTES ? 'City routes\nRoute of the water' : `${s.name}\nOpening hours and tickets.`);
  read('https://en.wikipedia.org/wiki/Plaza_de_Espa%C3%B1a,_Seville', 'Plaza de España\nA square in the Parque de María Luisa.');
  read('https://en.wikipedia.org/wiki/Casa_de_Murillo', 'Casa de Murillo\nThe house where Murillo lived.');
  // the turn's own add-point refuses the routes page now: it names neither place
  assert.equal((await pin(site, SIGHTS[2])).code, 2);
  for (const s of SIGHTS) assert.equal((await pinAsBefore(site, s)).code, 0);
  assert.equal((await plan(site)).code, 0);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1, v.out);
  const shared = v.json.errors.filter((e) => e.path === '$.plan.sights');
  assert.deepEqual(shared.map((e) => e.message), [`2 places cite one page (${ROUTES}): Plaza de España, Casa de Murillo. A page about a whole city or a list of places says which are worth it; it is not their source`]);
  assert.equal(shared[0].fix, 'cite each place\'s own page (its own site, else its Wikipedia article): uw cite <that page> --grep "<its name>", then uw set own <layer>:<id> --props-file - with {"source_url":"<that page>","source":"<site>"}; it gives the place\'s item in the days that page too, so the days stay as they are');
  // each with its own page, as the fix says: no new plan, and each place's item in the days links its own page
  const days = cfgOf(site).plan.days.map((d) => (d.items || []).map((it) => it.ref?.id));
  for (const [id, page] of [['plaza-espana', 'https://en.wikipedia.org/wiki/Plaza_de_Espa%C3%B1a,_Seville'], ['murillo', 'https://en.wikipedia.org/wiki/Casa_de_Murillo']]) {
    const s = await uw(['set', site, `sights:${id}`, '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: page, source: 'Wikipedia' }) });
    assert.equal(s.code, 0, s.out + s.err);
    assert.equal(s.json.day_items, 1, 'its item in the days links the new page');
    assert.deepEqual([itemOf(site, id).url, itemOf(site, id).source], [page, 'Wikipedia']);
  }
  assert.deepEqual(cfgOf(site).plan.days.map((d) => (d.items || []).map((it) => it.ref?.id)), days, 'the days are as they were');
  const ok = await uw(['validate', site, '--json']);
  assert.equal(ok.code, 0, JSON.stringify(ok.json?.errors ?? ok.out, null, 1));
  assert.deepEqual(ok.json.warnings.filter((w) => w.path === '$.plan.sights'), []);
});

// A later turn: the first turn ran out of time with two places on one page (a warning), and the person then moved a
// place to another day. Places on one page still fail while the turn has time, but the fix keeps the days: uw set gives
// each place's own page to its item in the days too, so no new plan (`uw plan --force` groups the days by area again,
// which put the moved place back), and the Plan tab links the page that names each place.
test('a later turn: places on one page fail while it has time, and the fix keeps the days the person changed', async () => {
  const site = 'own-later';
  await newTrip(site);
  for (const s of SIGHTS) assert.equal((await pinAsBefore(site, s)).code, 0);
  const turn1 = hostClock(450);
  assert.equal((await plan(site, { clock: turn1 })).code, 0);
  const late = await uw(['validate', site, '--json'], { clock: turn1 });
  assert.equal(late.code, 0, JSON.stringify(late.json?.errors ?? late.out, null, 1));
  assert.match(late.json.warnings.find((w) => w.path === '$.plan.sights')?.fix ?? '', /^too little time is left/);
  // the next turn: the person moves the archive to the day after its own (itinerary.md "Later changes")
  const cfg = cfgOf(site);
  const from = dayOf(site, 'indies');
  const to = (from + 1) % cfg.plan.days.length;
  const [moved] = cfg.plan.days[from].items.splice(cfg.plan.days[from].items.findIndex((it) => it.ref?.id === 'indies'), 1);
  cfg.plan.days[to].items.push(moved);
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  const turn2 = hostClock(0);
  const v = await uw(['validate', site, '--json'], { clock: turn2 });
  assert.equal(v.code, 1, v.out);
  const e = v.json.errors.find((x) => x.path === '$.plan.sights');
  assert.ok(e, JSON.stringify(v.json.errors));
  assert.doesNotMatch(e.fix, /uw plan|--force/, 'the fix never plans the days again');
  // a note for a day, or on a place, gives no page: taken while places still share one
  assert.equal((await uw(['set', site, 'plan:day1', '--note', 'Book the cathedral ahead.'], { clock: turn2 })).code, 0);
  assert.equal((await uw(['set', site, 'sights:murillo', '--note', 'Closed on Mondays.'], { clock: turn2 })).code, 0);
  assert.equal(cfgOf(site).plan.days[0].note, 'Book the cathedral ahead.');
  // as the fix says
  const pages = { 'plaza-espana': 'https://en.wikipedia.org/wiki/Plaza_de_Espa%C3%B1a,_Seville', murillo: 'https://en.wikipedia.org/wiki/Casa_de_Murillo' };
  for (const [id, page] of Object.entries(pages))
    assert.equal((await uw(['set', site, `sights:${id}`, '--props-file', '-'], { input: JSON.stringify({ source_url: page, source: 'Wikipedia' }), clock: turn2 })).code, 0);
  const ok = await uw(['validate', site, '--json'], { clock: turn2 });
  assert.equal(ok.code, 0, JSON.stringify(ok.json?.errors ?? ok.out, null, 1));
  assert.equal(dayOf(site, 'indies'), to, 'the move stays');
  for (const [id, page] of Object.entries(pages)) assert.deepEqual([itemOf(site, id).url, itemOf(site, id).source], [page, 'Wikipedia'], `${id}'s item links its own page`);
  assert.doesNotMatch(JSON.stringify(cfgOf(site).plan), /city-routes/);
});

test('add-point and set refuse a page uw cite read that does not name the place, one place alone on it too: cite its own page; nothing added or changed; no second request', async () => {
  const site = 'cited';
  await newTrip(site);
  const routes = `${mock.url}/en/city-routes/`, own = `${mock.url}/en/plaza-de-espana`;
  const file = path.join(tmp, site, 'data', 'sights.geojson');
  const c = await uw(['cite', routes, '--grep', 'Plaza de España']);
  assert.equal(c.code, 2, c.out + c.err);
  assert.match(c.out, /no line matches/);
  const pages = () => hits.filter((p) => p.startsWith('/en/')).length;
  const read = pages();

  // add-point with that page as its source: refused once the place is found (its names are known then), as uw
  // validate would fail it; nothing added, and the place is not "not found yet"
  const square = (url) => uw(['add-point', site, '--layer', 'sights', '--query', 'Plaza de España, Seville', '--near', CITY.join(','), '--id', 'plaza-espana', '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'seville', source_url: url, source: 'Visita Sevilla' }) });
  const a = await square(routes);
  assert.equal(a.code, 2, a.out + a.err);
  assert.deepEqual(a.json, { ok: false, refused: 'source_not_named', layer: 'sights', id: 'plaza-espana', source_url: routes, next: 'uw cite <its own page> --grep "Plaza de España"' });
  assert.deepEqual(a.err.trim().split('\n'), [
    `REFUSED: ${routes} (read by uw cite) does not name "Plaza de España": it is not this place's source. Cite its own page first (its own site, else its Wikipedia article), then run this command again with that page as its source_url:`,
    '  uw cite <its own page> --grep "Plaza de España"',
    'Nothing was added.',
  ]);
  assert.equal(fs.existsSync(file), false, 'nothing was added');
  assert.equal(cfgOf(site).missing, undefined, 'it was found: never "not found yet"');
  // set: one place alone on the page is refused too, and nothing changed
  assert.equal((await uw(['add-point', site, '--layer', 'sights', '--at', '-5.987249,37.390239', '--name', 'Casa de Pilatos', '--id', 'pilatos'])).code, 0);
  const before = fs.readFileSync(file, 'utf8');
  const s = await uw(['set', site, 'sights:pilatos', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: routes, source: 'Visita Sevilla' }) });
  assert.equal(s.code, 2, s.out + s.err);
  assert.deepEqual([s.json.refused, s.json.next], ['source_not_named', 'uw cite <its own page> --grep "Casa de Pilatos"']);
  assert.match(s.err, /^REFUSED: .* does not name "Casa de Pilatos": it is not this place's source\. Cite its own page first/m);
  assert.match(s.err, /^Nothing was changed\.$/m);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was changed');
  assert.equal(pages(), read, 'no page was read again');

  // the place's own page, which names it (accents aside): pinned, nothing said
  assert.equal((await uw(['cite', own, '--grep', 'Plaza'])).code, 0);
  const fixed = await square(own);
  assert.equal(fixed.code, 0, fixed.out + fixed.err);
  assert.equal(fixed.json.source_not_named, undefined);
  assert.doesNotMatch(fixed.err, /does not name|REFUSED/);
  // a page uw cite did not read is no source yet: refused at once ("cite it first"), and not read
  const reqs = hits.length;
  const unread = await uw(['set', site, 'sights:pilatos', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: `${mock.url}/en/casa-de-pilatos`, source: 'Visita Sevilla' }) });
  assert.equal(unread.code, 2, unread.out + unread.err);
  assert.equal(unread.json.refused, 'source_not_read');
  assert.equal(hits.length, reqs, 'set makes no request');
});

// Two places on one page met only `uw validate`, at the end of a turn: the archive beside a cathedral cited the
// cathedral's own site, and the turn then moved both to Wikipedia, the cathedral off its own site. The step that gives a
// place a page another place cites is refused at once, as validate judges them (cmd-set.mjs sourceNotOwn)
test('add-point and set refuse a page another place already cites: cite its own page; the same place again, or a place to stay, is not two places on it', async () => {
  const site = 'shared';
  await newTrip(site);
  const [cathedral, indies] = [SIGHTS[0], SIGHTS[5]];
  // the cathedral's own site names the archive beside it, and the quarter both stand in
  read(cathedral.page, 'Cathedral of Seville\nIn the Santa Cruz quarter, beside the General Archive of the Indies.');
  read(indies.page, 'General Archive of the Indies\nDocuments of the Spanish empire.');
  const file = path.join(tmp, site, 'data', 'sights.geojson');
  const add = (s, url, layer = 'sights', more = {}) => uw(['add-point', site, '--layer', layer, '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'seville', source_url: url, source: new URL(url).hostname.replace(/^www\./, ''), ...more }) });
  assert.equal((await add(cathedral, cathedral.page)).code, 0);
  const before = fs.readFileSync(file, 'utf8');
  const a = await add(indies, cathedral.page);
  assert.equal(a.code, 2, a.out + a.err);
  assert.deepEqual(a.json, { ok: false, refused: 'source_shared', layer: 'sights', id: 'indies', source_url: cathedral.page,
    next: 'uw cite <its own page> --grep "General Archive of the Indies"', cited_by: { ref: 'sights:cathedral', name: 'Cathedral of Seville' } });
  assert.deepEqual(a.err.trim().split('\n'), [
    `REFUSED: ${cathedral.page} (read by uw cite) is the page Cathedral of Seville (sights:cathedral) cites too: it is not this place's source (a page two places share is about a city or a list of places). Cite its own page first (its own site, else its Wikipedia article), then run this command again with that page as its source_url:`,
    '  uw cite <its own page> --grep "General Archive of the Indies"',
    'If this page is the site of "General Archive of the Indies" itself, it is Cathedral of Seville\'s source that is wrong: give that place its own page (uw set shared sights:cathedral --props-file - with {"source_url":"<its own page>","source":"<site>"}), then run this command again. Nothing was added.',
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing was added');
  assert.equal(cfgOf(site).missing, undefined, 'it was found: never "not found yet"');
  // its own page is taken; the days planned, uw set gives it the cathedral's page (another part of it): refused
  assert.equal((await add(indies, indies.page)).code, 0);
  assert.equal((await plan(site, { clock: hostClock(450) })).code, 0);
  const planned = fs.readFileSync(file, 'utf8');
  const s = await uw(['set', site, 'sights:indies', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: `${cathedral.page}#archive`, source: 'catedraldesevilla.es' }) });
  assert.equal(s.code, 2, s.out + s.err);
  assert.deepEqual([s.json.refused, s.json.cited_by], ['source_shared', { ref: 'sights:cathedral', name: 'Cathedral of Seville' }]);
  assert.match(s.err, /Nothing was changed\.$/m);
  assert.equal(fs.readFileSync(file, 'utf8'), planned, 'nothing was changed');
  // the same place pinned again under its own id keeps its page: one place is not two
  assert.equal((await add(cathedral, cathedral.page)).code, 0);
  // the quarter pinned as the area to stay in, from the page that names it: validate never judges a place to stay with
  // the sights
  const quarter = { id: 'santa-cruz', name: 'Santa Cruz', at: [-5.9901, 37.3858] };
  const area = await uw(['add-point', site, '--layer', 'stays', '--at', quarter.at.join(','), '--name', quarter.name, '--kind', 'area', '--id', quarter.id, '--props-file', '-', '--json'],
    { input: JSON.stringify({ stop: 'seville', note: 'Area to stay in: beside the cathedral.', source_url: cathedral.page, source: 'catedraldesevilla.es' }) });
  assert.equal(area.code, 0, area.out + area.err);
  const v = await uw(['validate', site, '--json']);
  assert.deepEqual([...v.json.errors, ...v.json.warnings].filter((e) => /cite one page|does not name/.test(e.message)), []);
});

// A step refuses only what `uw validate` fails, and everything it fails: a trip's places to see, judged among the places
// the plan takes (before the days are planned, every pinned place but the stops and the places to stay), and an area to
// stay in that says why, while the turn has time to cite. Elsewhere validate judges no page, and the step only says so
const pageMsgs = (v) => [...(v.json?.errors || []), ...(v.json?.warnings || [])].filter((e) => /cite one page|does not name/.test(e.message)).map((e) => e.message);
const pinTo = (site, layer, s, page, more = {}, env = {}) => uw(['add-point', site, '--layer', layer, '--at', s.at.join(','), '--name', s.name, '--id', s.id, ...(s.kind ? ['--kind', s.kind] : []), '--props-file', '-', '--json'],
  { input: JSON.stringify({ stop: 'seville', ...more, ...(page ? { source_url: page, source: new URL(page).hostname.replace(/^www\./, '') } : {}) }), env });

test('a map that is not a trip: a page two places share, or one that does not name a place, is said and taken, as uw validate judges neither', async () => {
  const site = 'cafes';
  assert.equal((await uw(['new', site, '--title', 'Cafes in Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  const list = 'https://cafes.example.org/best-cafes', hours = 'https://cafes.example.org/opening-hours';
  read(list, 'The best cafes\nCafe Alpha roasts its own coffee.\nCafe Beta bakes the cakes.');
  read(hours, 'Opening hours\nMonday to Friday, 8 to 18.');
  const cafe = (s, page) => pinTo(site, 'cafes', s, page, { stop: undefined });
  assert.equal((await cafe({ id: 'alpha', name: 'Cafe Alpha', at: [-5.9905, 37.3881] }, list)).code, 0);
  const beta = await cafe({ id: 'beta', name: 'Cafe Beta', at: [-5.9921, 37.3893] }, list);
  assert.equal(beta.code, 0, beta.out + beta.err);
  assert.doesNotMatch(beta.err, /REFUSED|cites too/);
  const gamma = await cafe({ id: 'gamma', name: 'Cafe Gamma', at: [-5.9942, 37.3871] }, hours);
  assert.equal(gamma.code, 0, gamma.out + gamma.err);
  assert.deepEqual(gamma.json.source_not_named, { url: hours, name: 'Cafe Gamma' });
  assert.match(gamma.err, /does not name "Cafe Gamma": it is not this place's source\. Cite the place's own page/);
  assert.equal((await uw(['set', site, 'cafes:gamma', '--props-file', '-'], { input: JSON.stringify({ source_url: list, source: 'cafes.example.org' }) })).code, 0);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out));
  assert.deepEqual(pageMsgs(v), []);
});

test('a trip not planned yet: a page a place in another layer cites is refused, as uw validate fails it once the plan takes both; a place to stay, or a layer the plan does not take, is not judged', async () => {
  const site = 'layers';
  await newTrip(site);
  const quarter = 'https://www.triana.example.org/guide', market = 'https://www.mercado.example.org/', booking = 'https://www.booking.example.org/rooms';
  read(quarter, 'The Triana guide\nThe Castle of San Jorge stands by the bridge.\nMercado de Triana sells fish.');
  read(market, 'Mercado de Triana\nStalls, fish and tapas.');
  read(booking, 'Book a room\nRooms from 80 euros a night.');
  const castle = { id: 'castle', name: 'Castle of San Jorge', at: [-6.0029, 37.3866] }, stall = { id: 'market', name: 'Mercado de Triana', at: [-6.0035, 37.3857] };
  assert.equal((await pinTo(site, 'sights', castle, quarter)).code, 0);
  const shared = await pinTo(site, 'food', stall, quarter);
  assert.equal(shared.code, 2, shared.out + shared.err);
  assert.deepEqual([shared.json.refused, shared.json.cited_by], ['source_shared', { ref: 'sights:castle', name: 'Castle of San Jorge' }]);
  assert.match(shared.err, /it is Castle of San Jorge's source that is wrong: give that place its own page \(uw set layers sights:castle --props-file - /);
  // a place to stay is never judged with the places to see: its booking page that does not name it is said, not refused
  const hotel = await pinTo(site, 'hotels', { id: 'uno', name: 'Hotel Uno', at: [-5.9912, 37.3874], kind: 'hotel' }, booking);
  assert.equal(hotel.code, 0, hotel.out + hotel.err);
  assert.deepEqual(hotel.json.source_not_named, { url: booking, name: 'Hotel Uno' });
  assert.equal((await pinTo(site, 'food', stall, market)).code, 0);
  for (const s of [SIGHTS[0], SIGHTS[1]]) { read(s.page, `${s.name}\nOpening hours and tickets.`); assert.equal((await pin(site, s)).code, 0); }
  assert.equal((await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-02', '--sights', 'sights,food', '--force'], { clock: hostClock(450) })).code, 0);
  assert.deepEqual(pageMsgs(await uw(['validate', site, '--json'])), []);
  // the days planned with sights and food: a day trip's layer is not judged with them, and a food place is
  const trip = await pinTo(site, 'daytrips', { id: 'carmona', name: 'Carmona', at: [-5.6413, 37.4712] }, quarter);
  assert.equal(trip.code, 0, trip.out + trip.err);
  assert.deepEqual(trip.json.source_not_named, { url: quarter, name: 'Carmona' });
  const food = await uw(['set', site, 'food:market', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: `${quarter}#market`, source: 'triana.example.org' }) });
  assert.equal(food.code, 2, food.out + food.err);
  assert.deepEqual([food.json.refused, food.json.cited_by], ['source_shared', { ref: 'sights:castle', name: 'Castle of San Jorge' }]);
  // what the steps took, validate takes; what they refused, it fails
  assert.deepEqual(pageMsgs(await uw(['validate', site, '--json'])), []);
  const file = path.join(tmp, site, 'data', 'food.geojson');
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  fc.features[0].properties.source_url = quarter;
  fs.writeFileSync(file, JSON.stringify(fc));
  assert.deepEqual(pageMsgs(await uw(['validate', site, '--json'])), [`2 places cite one page (${quarter}): Castle of San Jorge, Mercado de Triana. A page about a whole city or a list of places says which are worth it; it is not their source`]);
});

test('with too little time left to cite, add-point and set take the page and say the reply names the place as not checked, as uw validate only warns then', async () => {
  const site = 'late-step';
  await newTrip(site);
  const [cathedral, alcazar, pilatos] = [SIGHTS[0], SIGHTS[1], SIGHTS[4]];
  for (const s of [cathedral, alcazar, pilatos]) { read(s.page, `${s.name}\nOpening hours and tickets.`); assert.equal((await pin(site, s)).code, 0); }
  const late = hostClock(540);
  assert.equal((await plan(site, { clock: late })).code, 0);
  const s = await uw(['set', site, 'sights:pilatos', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: cathedral.page, source: 'catedraldesevilla.es' }), clock: late });
  assert.equal(s.code, 0, s.out + s.err);
  assert.ok(s.err.includes(`warning: ${cathedral.page} (read by uw cite) is the page Cathedral of Seville (sights:cathedral) cites too: it is not this place's source. Too little time is left to cite its own page in this turn: the reply names "Casa de Pilatos" as not checked on a page of its own.`), s.err);
  const v = await uw(['validate', site, '--json'], { clock: late });
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out));
  assert.deepEqual(pageMsgs(v), [`2 places cite one page (${cathedral.page}): Cathedral of Seville, Casa de Pilatos. A page about a whole city or a list of places says which are worth it; it is not their source`]);
  const unnamed = 'https://www.sevilla.example.org/what-to-see';
  read(unnamed, 'What to see\nThe river and its bridges.');
  const a = await pinTo(site, 'sights', { id: 'giralda', name: 'La Giralda', at: [-5.99258, 37.38634] }, unnamed, {}, { INSTAFY_TURN_STARTED_AT: late.started, INSTAFY_TURN_DEADLINE: late.deadline });
  assert.equal(a.code, 0, a.out + a.err);
  assert.ok(a.json.warnings.includes(`${unnamed} (read by uw cite) does not name "La Giralda": it is not this place's source. Too little time is left to cite its own page in this turn: the reply names "La Giralda" as not checked on a page of its own.`), a.err);
  // the next turn has time: the same page is refused, as validate now fails it
  const next = hostClock(0);
  assert.equal((await uw(['set', site, 'sights:alcazar', '--props-file', '-'], { input: JSON.stringify({ source_url: cathedral.page, source: 'catedraldesevilla.es' }), clock: next })).code, 2);
  assert.equal((await uw(['validate', site, '--json'], { clock: next })).code, 1);
});

test('an area to stay in that says why is refused a page that does not name it, as uw validate fails it; with no reason given it is said and taken', async () => {
  const site = 'area-why';
  await newTrip(site);
  const advice = 'https://www.stay.example.org/where-to-stay';
  read(advice, 'Where to stay\nStay near the river, close to the bridges.');
  const area = { id: 'santa-cruz', name: 'Santa Cruz', at: [-5.9901, 37.3858], kind: 'area' };
  const why = await pinTo(site, 'stays', area, advice, { note: 'Area to stay in: quiet lanes near the sights.' });
  assert.equal(why.code, 2, why.out + why.err);
  assert.equal(why.json.refused, 'source_not_named');
  const bare = await pinTo(site, 'stays', area, advice);
  assert.equal(bare.code, 0, bare.out + bare.err);
  assert.deepEqual(bare.json.source_not_named, { url: advice, name: 'Santa Cruz' });
  assert.deepEqual(pageMsgs(await uw(['validate', site, '--json'])), []);
  // given its reason by a step judged elsewhere (uw handoff's), validate fails it
  assert.equal((await pinTo(site, 'stays', area, advice, { note: 'Area to stay in: quiet lanes near the sights.' }, STEP)).code, 0);
  assert.deepEqual(pageMsgs(await uw(['validate', site, '--json'])), [`the area Santa Cruz (stays:santa-cruz) says why to stay there ("Area to stay in: quiet lanes near the sights.") but cites a page that does not name it (${advice})`]);
});

test('validate: a day with nothing to see names the reader, uw cite on each place\'s own page in this turn, never a browser card', async () => {
  const site = 'bare';
  await newTrip(site);
  // pinned with no page, as the first turn did; the plan written with too little time left to add places (with more,
  // it refuses days with fewer than two places that have their own page)
  for (const s of SIGHTS.slice(0, 5)) assert.equal((await pin(site, { ...s, page: null })).code, 0);
  assert.equal((await plan(site)).code, 2);
  assert.equal((await plan(site, { clock: hostClock(450) })).code, 0);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1, v.out);
  const e = v.json.errors.find((x) => x.path === '$.plan.days');
  assert.equal(e.message, '3 of 3 full days have nothing to see (no sourced place): Mon 2 Nov · Seville, Tue 3 Nov · Seville, Wed 4 Nov · Seville');
  assert.equal(e.fix, 'uw plan bare … --sights sights --force spreads the places already pinned over every day, the arrival day too: run it first when a stop has two places for each of its days. '
    + 'Else cite 2-3 places for each of those days in this turn, each from its own page (its own site, else its Wikipedia article): uw cite <page> --grep "<its name>", never a browser card; '
    + 'then uw add-point bare --layer sights … with {"stop":…,"source_url":…}; the 5 places pinned with no page: uw set bare <layer>:<id> --props-file - with {"source_url":…,"source":…} '
    + '(reference/itinerary.md Phase B step 1), then run it; a place the lookup cannot pin goes on its day as {"text": "<name>", "url": "<its page>", "source": "<site>"}');
  assert.doesNotMatch(JSON.stringify(v.json.errors), /a page you read names/);
});
