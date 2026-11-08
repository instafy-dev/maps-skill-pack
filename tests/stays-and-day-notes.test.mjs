// "Plan 3 days in Seville for a first visit: where to stay, what to see each day, on a map." then "Add a note to day 1:
// book the Alcázar tickets ahead." (a run on 5 Nov 2026). The turn made its map without --expect, pinned the Santa
// Cruz area as the place to stay before it had read any page ("Recommended base area for first-time visitors"), never
// ran uw stay, and uw validate passed: the map had no hotel. The note went on the city's stop with `uw set … --note`,
// since `uw set` reaches only a layer's features, and the reply called it "a day 1 note". Now:
//  - a stop with nights is a trip's, "expect" or not: uw validate fails while its only stay is an area and uw stay has
//    not looked there, naming the command; uw stay takes the stays layer the area was pinned in, and its places to
//    stay take the area's place; an area stays the recommendation only once uw stay found none, and its note says why
//    only from a page uw cite read;
//  - `uw set <site> plan:day1 --note "…"` gives day 1 its own note, nothing else, and uw plan --force keeps it.
// Offline: the place search, the lodging search and the walking router are a local mock in this file.
// Run: node --test tests/stays-and-day-notes.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-stays-notes-'));
// what uw cite read is kept in this test's own shared cache, the way uw cite keeps it
delete process.env.UW_NO_CACHE;
process.env.UW_CACHE = path.join(tmp, 'cache');
const { rememberCited } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-cite.mjs')).href);
const { haversine } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'util.mjs')).href);
const read = (url, text) => rememberCited([url], { url, title: '', retrieved_at: new Date().toISOString(), text });

// Seville as the place search answers it, and its lodging near Santa Cruz (as tests/one-city-trip.test.mjs has them)
const CITY = [-5.99534, 37.38863];
const SANTA_CRUZ = [-5.9905, 37.3855];
const CARMONA = [-5.6413, 37.4712];
const SIGHTS = [
  { id: 'catedral', name: 'Catedral de Sevilla', c: [-5.993141, 37.385915], page: 'https://en.wikipedia.org/wiki/Seville_Cathedral', text: 'Seville Cathedral (Catedral de Sevilla) is the cathedral of Seville.' },
  { id: 'alcazar', name: 'Real Alcázar de Sevilla', c: [-5.990183, 37.383211], page: 'https://en.wikipedia.org/wiki/Alc%C3%A1zar_of_Seville', text: 'The Real Alcázar de Sevilla is a royal palace.' },
  { id: 'pilatos', name: 'Casa de Pilatos', c: [-5.987249, 37.390239], page: 'https://en.wikipedia.org/wiki/Casa_de_Pilatos', text: 'Casa de Pilatos is an Andalusian palace.' },
  { id: 'triana', name: 'Mercado de Triana', c: [-6.00355, 37.38575], page: 'https://es.wikipedia.org/wiki/Mercado_de_Triana', text: 'El Mercado de Triana es un mercado.' },
  { id: 'santa-ana', name: 'Iglesia de Santa Ana', c: [-6.00296, 37.38326], page: 'https://es.wikipedia.org/wiki/Iglesia_de_Santa_Ana_(Sevilla)', text: 'La Iglesia de Santa Ana es una iglesia.' },
  { id: 'maria-luisa', name: 'Parque de María Luisa', c: [-5.988956, 37.378779], page: 'https://en.wikipedia.org/wiki/Parque_de_Mar%C3%ADa_Luisa', text: 'Parque de María Luisa is a public park.' },
];
const off = (c, dx, dy) => [Math.round((c[0] + dx / 88400) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const LODGING = [
  { type: 'node', id: 801, c: off(SANTA_CRUZ, 150, 0), tags: { tourism: 'hotel', name: 'Hotel Patio de la Cruz', stars: '3' } },
  { type: 'way', id: 802, c: off(SANTA_CRUZ, 0, 300), tags: { tourism: 'hotel', name: 'Hotel Judería' } },
  { type: 'node', id: 803, c: off(SANTA_CRUZ, 350, -350), tags: { tourism: 'hotel', name: 'Hotel Murallas', rooms: '40' } },
];
const SEVILLA = { district: 'Casco Antiguo', city: 'Sevilla', state: 'Andalucía', country: 'España', countrycode: 'ES' };
const photon = (name, c, key, value, id, extra = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c },
  properties: { osm_type: 'N', osm_id: id, osm_key: key, osm_value: value, name, ...SEVILLA, ...extra } });
function photonAnswer(q, en) {
  if (/^(Sevilla|Seville)$/.test(q)) return [photon(en ? 'Seville' : 'Sevilla', CITY, 'place', 'city', 342563, { osm_type: 'R', district: undefined, city: undefined })];
  if (q === 'Santa Cruz, Seville') return [photon('Santa Cruz', SANTA_CRUZ, 'place', 'neighbourhood', 4649140, { osm_type: 'R' })];
  if (q === 'Carmona') return [photon('Carmona', CARMONA, 'place', 'town', 342600, { osm_type: 'R', district: undefined, city: undefined })];
  const s = SIGHTS.find((x) => x.name === q);
  return s ? [photon(s.name, s.c, 'tourism', 'attraction', 7100 + SIGHTS.indexOf(s))] : [];
}

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
      const feats = u.searchParams.getAll('osm_tag').length ? [] : photonAnswer(u.searchParams.get('q') || '', u.searchParams.get('lang') === 'en');
      res.end(JSON.stringify({ type: 'FeatureCollection', features: feats.map((f) => ({ ...f, properties: Object.fromEntries(Object.entries(f.properties).filter(([, v]) => v !== undefined)) })) }));
      return;
    }
    if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
    if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        const a = q.match(/around:(\d+),(-?[\d.]+),(-?[\d.]+)/);
        const near = (e) => !a || haversine([Number(a[3]), Number(a[2])], e.c) <= Number(a[1]);
        const elements = /"tourism"~/.test(q) ? LODGING.filter(near).map((e) => (e.type === 'node' ? { type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: e.tags }
          : { type: e.type, id: e.id, center: { lon: e.c[0], lat: e.c[1] }, tags: e.tags })) : [];
        res.end(JSON.stringify({ elements }));
      });
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mock = { server, url: `http://127.0.0.1:${server.address().port}` };
  // the sights' own pages, read by uw cite in this turn
  for (const s of SIGHTS) read(s.page, s.text);
});
after(() => { mock?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// the pack's own turn clock (one turn: no command waits 150 s), never the clock of a turn that runs these tests
const uw = (args, { input = null, env: extra = {} } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  Object.assign(env, extra);
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features;
const ok = (r, what) => assert.equal(r.code, 0, `${what}: ${r.out}${r.err}`);

/** The run's map, as its turn built it: no --expect, the city with its nights, the area pinned as the place to stay
 *  with a note no page said, six sights from their own pages, and the plan. `stop`: the stop's id; `area`: the area's
 *  props (its "stop" too). */
async function runsMap(site, { stop = 'seville', area = { stop, note: 'Recommended base area for first-time visitors; historic centre location.' } } = {}) {
  ok(await uw(['new', site, '--title', 'Three days in Seville', '--ask', 'Where to stay and what to see each day', '--center', SANTA_CRUZ.join(','), '--zoom', '13']), 'new');
  ok(await uw(['add-point', site, '--layer', 'stops', '--query', 'Seville', '--country', 'ES', '--kind', 'city', '--id', stop, '--props', '{"nights":3}']), 'the stop');
  ok(await uw(['add-point', site, '--layer', 'stays', '--query', 'Santa Cruz, Seville', '--near', SANTA_CRUZ.join(','), '--id', 'santa-cruz-area', '--kind', 'area', '--props-file', '-'],
    { input: JSON.stringify(area) }), 'the area');
  for (const s of SIGHTS) {
    ok(await uw(['add-point', site, '--layer', 'sights', '--query', s.name, '--country', 'ES', '--strict-name', '--near', SANTA_CRUZ.join(','), '--id', s.id, '--props-file', '-'],
      { input: JSON.stringify({ stop, source_url: s.page, source: 'Wikipedia' }) }), s.name);
  }
  ok(await uw(['plan', site, '--stops', 'stops', '--ids', stop, '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights']), 'plan');
  ok(await uw(['fit', site]), 'fit');
}
/** The `uw stay` command a validate error names, as words to run (its fix starts with it). */
const stayCmd = (fix) => fix.match(/^uw (stay [^(]+?) \(/)[1].split(' ');
const staysError = (v) => v.json.errors.find((e) => /^places to stay:/.test(e.message));
/** A small one-stop trip for the stays checks: the city (2 nights) and what is pinned in its stays layer. */
async function smallTrip(site, pins) {
  ok(await uw(['new', site, '--title', 'Seville', '--center', SANTA_CRUZ.join(','), '--zoom', '13']), 'new');
  ok(await uw(['add-point', site, '--layer', 'stops', '--query', 'Seville', '--country', 'ES', '--kind', 'city', '--id', 'seville', '--props', '{"nights":2}']), 'stop');
  for (const p of pins) {
    ok(await uw(['add-point', site, '--layer', 'stays', '--at', p.c.join(','), '--name', p.name, '--kind', p.kind, '--id', p.id, '--props-file', '-'], { input: JSON.stringify(p.props) }), p.name);
  }
  ok(await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '2', '--start', '2026-11-06', '--stays', 'stays']), 'plan');
  ok(await uw(['fit', site]), 'fit');
}

test('validate: a trip made without --expect fails while its only stay is an area pinned before uw stay looked, names the command; uw stay\'s hotels take the area\'s place, and validate passes', async () => {
  await runsMap('sv');
  assert.equal(cfgOf('sv').expect, undefined, 'the run\'s map: no "expect"');
  const v = await uw(['validate', 'sv', '--json']);
  assert.equal(v.code, 1, v.out + v.err);
  const stays = v.json.errors.find((e) => /^places to stay:/.test(e.message));
  assert.ok(stays, JSON.stringify(v.json.errors, null, 1));
  assert.equal(stays.message, 'places to stay: Seville (3 nights) has only the area Santa Cruz to stay in, and uw stay has not looked for any there');
  assert.equal(stays.file, 'data/stops.geojson');
  assert.match(stays.fix, /^uw stay sv --near stays:santa-cruz-area --stop seville --kinds hotel \(hotels unless the person asked for hostels; reference\/itinerary\.md "One base" step 2\), then uw plan sv … --stays stays --force/);
  assert.match(stays.fix, /None found within 3000 m \(exit 2\): the area is the recommendation, its note from a page you read, and the reply says no place to stay was found near it\. Exit 4 \(the search was busy\): the reply says places to stay were not looked up yet$/);
  // the area's note says why to stay there, and no page said it
  const note = v.json.errors.find((e) => /^the area Santa Cruz/.test(e.message));
  assert.ok(note, JSON.stringify(v.json.errors, null, 1));
  assert.equal(note.message, 'the area Santa Cruz (stays:santa-cruz-area) says why to stay there ("Recommended base area for first-time visitors; historic centre location.") but cites no page');
  assert.match(note.fix, /^read the page that says it: uw cite <that page> --grep "Santa Cruz", then uw set sv stays:santa-cruz-area --props-file - with \{"source_url":"<that page>","source":"<site>"\}; no such page: uw set sv stays:santa-cruz-area --unset note, and the reply says places to stay were not looked up yet$/);
  // only these two: the days, the sights and their pages are fine
  assert.equal(v.json.errors.length, 2, JSON.stringify(v.json.errors, null, 1));

  // the command it names, as printed: the stays layer add-point wrote takes the hotels, and they take the area's place
  const cmd = stays.fix.match(/^uw (stay [^(]+?) \(/)[1].split(' ');
  const r = await uw([...cmd, '--json']);
  ok(r, 'uw stay');
  assert.deepEqual(r.json.picks.map((p) => p.name), ['Hotel Patio de la Cruz', 'Hotel Judería', 'Hotel Murallas']);
  const after = layerOf('sv', 'stays');
  assert.deepEqual(after.map((f) => f.properties.kind), ['hotel', 'hotel', 'hotel'], 'the area went: its places to stay stand in its place');
  assert.ok(after.every((f) => f.properties.stop === 'seville' && /min walk to Santa Cruz/.test(f.properties.why)), JSON.stringify(after.map((f) => f.properties.why)));
  ok(await uw(['plan', 'sv', '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']), 'plan again');
  const days = cfgOf('sv').plan.days;
  assert.match(days[0].items[0].text, /^Base: Hotel Patio de la Cruz · \d+ min walk to Santa Cruz$/);
  assert.ok(days.every((d) => d.focus?.layer === 'stays' && d.focus.id === r.json.picks[0].id), JSON.stringify(days.map((d) => d.focus)));
  const v2 = await uw(['validate', 'sv', '--json']);
  assert.equal(v2.code, 0, JSON.stringify(v2.json?.errors ?? v2.out, null, 1));
  assert.ok(!v2.json.warnings.some((w) => /places to stay|says why to stay/.test(w.message)), JSON.stringify(v2.json.warnings, null, 1));
});

test('validate: with a list of places to stay the trip passes; an area stays the recommendation once uw stay found none, its note from a page uw cite read', async () => {
  // a list of places to stay, pinned by hand for the stop (a person's own picks): nothing to look up
  ok(await uw(['new', 'picks', '--title', 'Seville', '--center', SANTA_CRUZ.join(','), '--zoom', '13']), 'new');
  ok(await uw(['add-point', 'picks', '--layer', 'stops', '--query', 'Seville', '--country', 'ES', '--kind', 'city', '--id', 'seville', '--props', '{"nights":2}']), 'stop');
  for (const [i, h] of LODGING.entries()) {
    ok(await uw(['add-point', 'picks', '--layer', 'stays', '--at', h.c.join(','), '--name', h.tags.name, '--kind', 'hotel', '--id', `h${i}`, '--props', '{"stop":"seville"}']), h.tags.name);
  }
  ok(await uw(['plan', 'picks', '--stops', 'stops', '--ids', 'seville', '--nights', '2', '--start', '2026-11-06', '--stays', 'stays']), 'plan');
  ok(await uw(['fit', 'picks']), 'fit');
  const listed = await uw(['validate', 'picks', '--json']);
  assert.equal(listed.code, 0, JSON.stringify(listed.json?.errors ?? listed.out, null, 1));
  assert.ok(![...listed.json.errors, ...listed.json.warnings].some((m) => /places to stay|says why to stay/.test(m.message)), JSON.stringify(listed.json, null, 1));

  // a town with no lodging in reach: uw stay looked, found none, and the area to stay in is the recommendation
  ok(await uw(['new', 'cm', '--title', 'Carmona', '--center', CARMONA.join(','), '--zoom', '13']), 'new');
  ok(await uw(['add-point', 'cm', '--layer', 'stops', '--query', 'Carmona', '--country', 'ES', '--kind', 'town', '--id', 'carmona', '--props', '{"nights":2}']), 'stop');
  ok(await uw(['add-point', 'cm', '--layer', 'stays', '--at', CARMONA.join(','), '--name', 'Old town', '--kind', 'area', '--id', 'old-town', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'carmona', note: 'Area to stay in: inside the old walls.' }) }), 'the area');
  ok(await uw(['plan', 'cm', '--stops', 'stops', '--ids', 'carmona', '--nights', '2', '--start', '2026-11-06', '--stays', 'stays']), 'plan');
  ok(await uw(['fit', 'cm']), 'fit');
  const before = await uw(['validate', 'cm', '--json']);
  assert.ok(before.json.errors.some((e) => /^places to stay: Carmona \(2 nights\) has only the area Old town to stay in/.test(e.message)), JSON.stringify(before.json.errors, null, 1));
  const none = await uw(['stay', 'cm', '--near', 'stays:old-town', '--stop', 'carmona', '--kinds', 'hotel', '--radius', '3000']);
  assert.equal(none.code, 2, none.out + none.err);
  assert.match(none.out + none.err, /No lodging within 3000 m of Old town/);
  assert.equal(layerOf('cm', 'stays').length, 1, 'nothing found: the area stays');
  const looked = await uw(['validate', 'cm', '--json']);
  assert.ok(!looked.json.errors.some((e) => /^places to stay:/.test(e.message)), JSON.stringify(looked.json.errors, null, 1));
  // its note still says why, from no page: the page that says it is read, and the area cites it
  const why = looked.json.errors.find((e) => /^the area Old town \(stays:old-town\) says why to stay there \("Area to stay in: inside the old walls\."\) but cites no page$/.test(e.message));
  assert.ok(why, JSON.stringify(looked.json.errors, null, 1));
  const page = 'https://en.wikipedia.org/wiki/Carmona,_Spain';
  read(page, 'Carmona. The old town lies inside the old walls, around the Alcázar.');
  // a page that does not name the area is not its source
  read('https://example.org/routes', 'Routes of the region.');
  ok(await uw(['set', 'cm', 'stays:old-town', '--props-file', '-'], { input: JSON.stringify({ source_url: 'https://example.org/routes', source: 'Routes' }) }), 'set the wrong page');
  const wrong = await uw(['validate', 'cm', '--json']);
  assert.ok(wrong.json.errors.some((e) => /^the area Old town .* but cites a page that does not name it \(https:\/\/example\.org\/routes\)$/.test(e.message)), JSON.stringify(wrong.json.errors, null, 1));
  ok(await uw(['set', 'cm', 'stays:old-town', '--props-file', '-'], { input: JSON.stringify({ source_url: page, source: 'Wikipedia' }) }), 'set the page');
  const sourced = await uw(['validate', 'cm', '--json']);
  assert.equal(sourced.code, 0, JSON.stringify(sourced.json?.errors ?? sourced.out, null, 1));
  assert.ok(![...sourced.json.errors, ...sourced.json.warnings].some((m) => /places to stay|says why to stay/.test(m.message)), JSON.stringify(sourced.json, null, 1));
});

test('validate: a later turn keeps the map it finds (an area pinned in an earlier turn is a warning); a stop with nights and no plan is a trip with no plan', async () => {
  await runsMap('later');
  // a later turn: the pack's turn clock (the site's state folder, .uwcache/ outside a space) starts after it was built
  const now = Date.now() + 1000;
  fs.writeFileSync(path.join(tmp, 'later', '.uwcache', 'turn.json'), JSON.stringify({ started: now, last: now }));
  const v = await uw(['validate', 'later', '--json']);
  assert.ok(!v.json.errors.some((e) => /places to stay|says why to stay/.test(e.message)), JSON.stringify(v.json.errors, null, 1));
  assert.ok(v.json.warnings.some((w) => /^places to stay: Seville \(3 nights\) has only the area Santa Cruz to stay in/.test(w.message)), JSON.stringify(v.json.warnings, null, 1));
  assert.ok(v.json.warnings.some((w) => /^the area Santa Cruz \(stays:santa-cruz-area\) says why to stay there/.test(w.message)), JSON.stringify(v.json.warnings, null, 1));
  // no plan: a trip, with or without "expect"
  ok(await uw(['new', 'noplan', '--title', 'Seville', '--center', SANTA_CRUZ.join(','), '--zoom', '13']), 'new');
  ok(await uw(['add-point', 'noplan', '--layer', 'stops', '--query', 'Seville', '--country', 'ES', '--kind', 'city', '--id', 'seville', '--props', '{"nights":3}']), 'stop');
  const n = await uw(['validate', 'noplan', '--json']);
  const plan = n.json.errors.find((e) => e.path === '$.plan');
  assert.ok(plan, JSON.stringify(n.json.errors, null, 1));
  assert.match(plan.message, /^a trip \(Seville \(3 nights\)\) with no plan/);
});

test('uw set plan:day1 --note writes day 1\'s own note and nothing else; uw plan --force keeps it; a day takes only a note', async () => {
  await runsMap('notes');
  ok(await uw(['stay', 'notes', '--near', 'stays:santa-cruz-area', '--stop', 'seville', '--kinds', 'hotel']), 'stays');
  ok(await uw(['plan', 'notes', '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']), 'plan');
  const dir = path.join(tmp, 'notes');
  const files = () => Object.fromEntries(fs.readdirSync(path.join(dir, 'data')).map((f) => [f, fs.readFileSync(path.join(dir, 'data', f), 'utf8')]));
  const dataBefore = files();
  const cfgBefore = cfgOf('notes');
  const r = await uw(['set', 'notes', 'plan:day1', '--note', 'Book the Alcázar tickets ahead.', '--json']);
  ok(r, 'set the note');
  assert.deepEqual(r.json, { ok: true, day: 1, title: 'Fri 6 Nov · Seville', note: 'Book the Alcázar tickets ahead.', changed: ['note'], shown: true });
  const cfg = cfgOf('notes');
  assert.equal(cfg.plan.days[0].note, 'Book the Alcázar tickets ahead.');
  assert.ok(cfg.plan.days.slice(1).every((d) => d.note === undefined), 'only day 1');
  delete cfg.plan.days[0].note;
  assert.deepEqual(cfg, cfgBefore, 'nothing else in the config changed');
  assert.deepEqual(files(), dataBefore, 'no place, stop or stay changed: the city\'s stop has no note');
  assert.ok(!layerOf('notes', 'stops').some((f) => f.properties.note), 'the stop has no note');
  const said = await uw(['set', 'notes', 'plan:day1', '--note', 'Book the Alcázar tickets ahead.']);
  assert.match(said.out, /^Nothing changed on day 1 \(Fri 6 Nov · Seville\)\./);
  const text = await uw(['set', 'notes', 'plan:day2', '--note', 'Flamenco show at 7 pm.']);
  assert.match(text.out, /^Day 2 \(Sat 7 Nov · Seville\) has its note: "Flamenco show at 7 pm\."\. The Plan tab shows it under the day's text, above its places\./);
  const v = await uw(['validate', 'notes', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));

  // a new plan keeps each day's note on its day
  const again = await uw(['plan', 'notes', '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']);
  ok(again, 'plan again');
  assert.match(again.out, /Day notes kept on their days: day 1, day 2 \(uw set notes plan:day<N> --note moves one\)\./);
  assert.deepEqual(cfgOf('notes').plan.days.map((d) => d.note ?? null), ['Book the Alcázar tickets ahead.', 'Flamenco show at 7 pm.', null]);
  // a shorter plan names the note of a day it no longer has
  const shorter = await uw(['plan', 'notes', '--stops', 'stops', '--ids', 'seville', '--nights', '1', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']);
  ok(shorter, 'shorter plan');
  assert.match(shorter.out, /Day notes of days this plan no longer has: day 2 "Flamenco show at 7 pm\."\. Put each on its day \(uw set notes plan:day<N> --note "…"\), or say it in the reply\./);

  // off again; a day that does not exist; a day takes only a note
  ok(await uw(['set', 'notes', 'plan:day1', '--unset', 'note']), 'unset');
  assert.equal(cfgOf('notes').plan.days[0].note, undefined);
  const missing = await uw(['set', 'notes', 'plan:day4', '--note', 'x']);
  assert.equal(missing.code, 1, missing.out + missing.err);
  assert.match(missing.err, /no day 4: the plan has 1 day \(day1: Fri 6 Nov · Seville\)/);
  const named = await uw(['set', 'notes', 'plan:day1', '--note', 'x', '--name', 'Day one']);
  assert.equal(named.code, 2, named.out + named.err);
  assert.match(named.err, /a day takes --note "…" or --unset note; --name is for a place: uw set notes <layer>:<id> …/);
  const long = await uw(['set', 'notes', 'plan:day1', '--note', 'x'.repeat(121)]);
  assert.equal(long.code, 2, long.out + long.err);
  assert.match(long.err, /--note is 121 characters: a day's note is one line under its text \(≤ 120\)/);
});

test('the skill names a day\'s note and a trip\'s stays: SKILL.md, the trip reference and uw set --help', async () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(md, /Trips: `reference\/itinerary\.md` "Later changes to a trip"; a day's note: `uw set <site> plan:day1 --note "…"`\./);
  const trip = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(trip, /and the reply says what `uw stay` said: none found near it \(exit 2\), or places to stay not looked up yet \(exit 4\)\. `uw validate` fails while a stop's only stay is an area and `uw stay` has not looked there \(widened to 3000 m when it found none\), or while an area's note cites no page `uw cite` read\./);
  assert.match(trip, /- A note for a day \("add a note to day 1: book the tickets ahead"\): `uw set <site> plan:day1 --note "<the note>"`, the day's own line under its text in the Plan tab/);
  const help = await uw(['set', '--help']);
  assert.match(help.out, /^set <dir> plan:day<N> --note "…" \| --unset note \[--json\]$/m);
});

test('uw stay keeps places it did not write: a traveller\'s own hotel and another area to stay in stay; only the area it looked around gives way, said by name', async () => {
  // the traveller's own booking, pinned for the stop as the trip reference pins a place, and the city's two areas
  const TRIANA = off(SANTA_CRUZ, -1150, 0);
  await smallTrip('own', [
    { id: 'my-hotel', name: 'Casa de la Persona', kind: 'hotel', c: off(SANTA_CRUZ, -200, 100), props: { stop: 'seville', note: 'Booked by me' } },
    { id: 'santa-cruz', name: 'Santa Cruz', kind: 'area', c: SANTA_CRUZ, props: { stop: 'seville' } },
    { id: 'triana', name: 'Triana', kind: 'area', c: TRIANA, props: { stop: 'seville' } },
  ]);
  const near = await uw(['stay', 'own', '--near', 'stops:seville', '--stop', 'seville', '--kinds', 'hotel', '--json']);
  ok(near, 'uw stay near the city');
  const ids = () => layerOf('own', 'stays').map((f) => f.properties.id);
  assert.ok(ids().includes('my-hotel'), `the traveller's own hotel stays: ${ids()}`);
  assert.equal(layerOf('own', 'stays').find((f) => f.properties.id === 'my-hotel').properties.note, 'Booked by me');
  assert.ok(ids().includes('santa-cruz') && ids().includes('triana'), `a lookup around the city takes no area's place: ${ids()}`);
  assert.equal(near.json.replaced, undefined);
  // validate's command for an area: that area gives way to the picks, by name; the other area and the hotel stay
  const around = await uw(['stay', 'own', '--near', 'stays:santa-cruz', '--stop', 'seville', '--kinds', 'hotel']);
  ok(around, 'uw stay around Santa Cruz');
  assert.match(around.out, /^These take the place of the area Santa Cruz \(stays:santa-cruz\)/m);
  assert.ok(!ids().includes('santa-cruz'), `the area it looked around gave way: ${ids()}`);
  assert.ok(ids().includes('my-hotel') && ids().includes('triana'), `the rest stay: ${ids()}`);
  // the other area's lookup: that area gives way too, and the traveller's own hotel still stays
  ok(await uw(['stay', 'own', '--near', 'stays:triana', '--stop', 'seville', '--kinds', 'hotel', '--radius', '3000', '--max', '1']), 'around Triana');
  assert.ok(!ids().includes('triana') && ids().includes('my-hotel'), `the traveller's own hotel stays: ${ids()}`);
  assert.equal(layerOf('own', 'stays').find((f) => f.properties.id === 'my-hotel').properties.note, 'Booked by me');
  // a layer of places picked by hand for no stop (the options of a choice) is not joined: another layer, named
  ok(await uw(['add-point', 'own', '--layer', 'stays', '--at', off(SANTA_CRUZ, 300, 300).join(','), '--name', 'Hotel Option', '--kind', 'hotel', '--id', 'option-a']), 'an option');
  const refused = await uw(['stay', 'own', '--near', 'stops:seville', '--stop', 'seville', '--kinds', 'hotel']);
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.err, /data\/stays\.geojson was written by "add-point"; use another --layer \(e\.g\. --layer hotels\)\./);
});

test('validate\'s uw stay runs as printed: an area pinned with no stop, and a stop whose id is not a slug, clear the error in one round', async () => {
  // the area pinned with no "stop" (one stop with nights: it is that stop's)
  await runsMap('nostop', { area: { note: 'Area to stay in.' } });
  const v = await uw(['validate', 'nostop', '--json']);
  const e = staysError(v);
  assert.ok(e, JSON.stringify(v.json.errors, null, 1));
  const r = await uw([...stayCmd(e.fix), '--json']);
  ok(r, 'the printed uw stay');
  assert.ok(!layerOf('nostop', 'stays').some((f) => f.properties.id === 'santa-cruz-area'), 'the area gave way');
  ok(await uw(['plan', 'nostop', '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']), 'plan again');
  const v2 = await uw(['validate', 'nostop', '--json']);
  assert.ok(!v2.json.errors.some((x) => /places to stay|says why to stay/.test(x.message)), JSON.stringify(v2.json.errors, null, 1));

  // a stop id add-point kept as given: uw stay files its picks and its lookup under that id
  await runsMap('slug', { stop: 'seville_city' });
  const s = staysError(await uw(['validate', 'slug', '--json']));
  assert.match(s.fix, /^uw stay slug --near stays:santa-cruz-area --stop seville_city --kinds hotel/);
  const picks = await uw([...stayCmd(s.fix), '--json']);
  ok(picks, 'the printed uw stay');
  assert.ok(picks.json.picks.every((p) => p.stop === 'seville_city'), JSON.stringify(picks.json.picks.map((p) => p.stop)));
  ok(await uw(['plan', 'slug', '--stops', 'stops', '--ids', 'seville_city', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']), 'plan again');
  assert.equal(cfgOf('slug').plan.days[0].focus.id, picks.json.picks[0].id, 'the days start at the first stay');
  const v3 = await uw(['validate', 'slug', '--json']);
  assert.equal(v3.code, 0, JSON.stringify(v3.json.errors, null, 1));
});

test('uw stay that takes the place of the area the days start at says to plan the days again, and so does validate', async () => {
  await runsMap('replan');
  const e = staysError(await uw(['validate', 'replan', '--json']));
  const r = await uw(stayCmd(e.fix));
  ok(r, 'the printed uw stay');
  assert.match(r.out, /^These take the place of the area Santa Cruz \(stays:santa-cruz-area\), where the days started: plan them again, uw plan replan … --stays stays --force \(each day starts at the first stay\)\.$/m);
  // before that, validate names the same fix for the days' places that are gone, never "ids look like"
  const v = await uw(['validate', 'replan', '--json']);
  const gone = v.json.errors.filter((x) => /no feature "santa-cruz-area"/.test(x.message));
  assert.ok(gone.length >= 2, JSON.stringify(v.json.errors, null, 1));
  for (const g of gone) assert.equal(g.fix, 'the days name a place no longer on the map: plan them again, uw plan replan … --force', JSON.stringify(g));
});

test('validate: uw stay that found none counts once widened to its widest; the reply\'s words come from what it found', async () => {
  // the lodging is 0.8 to 1.4 km from the area: none within the first 800 m
  await smallTrip('far', [{ id: 'far-area', name: 'Prado', kind: 'area', c: off(SANTA_CRUZ, 0, -1100), props: { stop: 'seville' } }]);
  const none = await uw(['stay', 'far', '--near', 'stays:far-area', '--stop', 'seville', '--kinds', 'hotel']);
  assert.equal(none.code, 2, none.out + none.err);
  const v = await uw(['validate', 'far', '--json']);
  const e = staysError(v);
  assert.ok(e, JSON.stringify(v.json.errors, null, 1));
  assert.equal(e.message, 'places to stay: Seville (2 nights) has only the area Prado to stay in, and uw stay found none within 800 m of it');
  assert.match(e.fix, /^uw stay far --near stays:far-area --stop seville --kinds hotel --radius 1600 \(the same lookup, wider\)/);
  const wider = await uw(stayCmd(e.fix));
  ok(wider, 'the printed widening');
  ok(await uw(['plan', 'far', '--stops', 'stops', '--ids', 'seville', '--nights', '2', '--start', '2026-11-06', '--stays', 'stays', '--force']), 'plan again');
  const v2 = await uw(['validate', 'far', '--json']);
  assert.ok(!v2.json.errors.some((x) => /places to stay/.test(x.message)), JSON.stringify(v2.json.errors, null, 1));

  // none at the widest: the area is the recommendation, and the reply says none was found, never "not looked up"
  await smallTrip('none', [{ id: 'old-town', name: 'Old town', kind: 'area', c: CARMONA, props: { stop: 'seville', note: 'Area to stay in: inside the old walls.' } }]);
  const v3 = await uw(['validate', 'none', '--json']);
  assert.match(staysError(v3).fix, /None found within 3000 m \(exit 2\): the area is the recommendation, its note from a page you read, and the reply says no place to stay was found near it\. Exit 4 \(the search was busy\): the reply says places to stay were not looked up yet$/);
  assert.equal((await uw(['stay', 'none', '--near', 'stays:old-town', '--stop', 'seville', '--kinds', 'hotel', '--radius', '3000'])).code, 2);
  const v4 = await uw(['validate', 'none', '--json']);
  assert.ok(!v4.json.errors.some((x) => /^places to stay:/.test(x.message)), JSON.stringify(v4.json.errors, null, 1));
  const why = v4.json.errors.find((x) => /^the area Old town/.test(x.message));
  assert.match(why.fix, /no such page: uw set none stays:old-town --unset note, and the reply says no place to stay was found within 3000 m of Old town$/);
});

test('validate: a square or a landmark pinned among the places to stay is not one', async () => {
  await smallTrip('sq', [{ id: 'plaza-nueva', name: 'Plaza Nueva', kind: 'square', c: off(SANTA_CRUZ, -600, 250), props: { stop: 'seville' } }]);
  const e = staysError(await uw(['validate', 'sq', '--json']));
  assert.ok(e, 'a square is not a place to stay');
  assert.equal(e.message, 'places to stay: Seville (2 nights) has only the area Plaza Nueva to stay in, and uw stay has not looked for any there');
  assert.match(e.fix, /^uw stay sq --near stays:plaza-nueva --stop seville --kinds hotel /);
  // a guest house, a hostel or an apartment is one
  await smallTrip('gh', [{ id: 'casa', name: 'Casa Sol', kind: 'guest_house', c: off(SANTA_CRUZ, -600, 250), props: { stop: 'seville' } }]);
  assert.equal(staysError(await uw(['validate', 'gh', '--json'])), undefined);
});

test('validate: a later turn that adds a sight and plans the days again is still warned about the stays, not made to look them up', async () => {
  await runsMap('later2');
  const now = Date.now() + 1000;
  fs.writeFileSync(path.join(tmp, 'later2', '.uwcache', 'turn.json'), JSON.stringify({ started: now, last: now }));
  await new Promise((r) => setTimeout(r, 1100));
  const page = 'https://en.wikipedia.org/wiki/Metropol_Parasol';
  read(page, 'Metropol Parasol is a wooden structure in Seville.');
  ok(await uw(['add-point', 'later2', '--layer', 'sights', '--at', off(SANTA_CRUZ, -150, 900).join(','), '--name', 'Metropol Parasol', '--kind', 'attraction', '--id', 'parasol', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'seville', source_url: page, source: 'Wikipedia' }) }), 'a sight');
  ok(await uw(['plan', 'later2', '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']), 'plan again');
  const v = await uw(['validate', 'later2', '--json']);
  assert.ok(!v.json.errors.some((x) => /places to stay|says why to stay/.test(x.message)), JSON.stringify(v.json.errors, null, 1));
  assert.ok(v.json.warnings.some((w) => /^places to stay: Seville/.test(w.message)), JSON.stringify(v.json.warnings, null, 1));
});

test('uw set plan:day1 --note on a map whose page was made before day notes says the page does not show it', async () => {
  await runsMap('old');
  ok(await uw(['stay', 'old', '--near', 'stays:santa-cruz-area', '--stop', 'seville', '--kinds', 'hotel']), 'stays');
  ok(await uw(['plan', 'old', '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights', '--force']), 'plan');
  // the map's own engine/ from a pack before day notes: its Plan tab draws a day's text and places only
  const ui = path.join(tmp, 'old', 'engine', 'ui.js');
  fs.writeFileSync(ui, fs.readFileSync(ui, 'utf8').split('\n').filter((l) => !/uw-day-note/.test(l)).join('\n'));
  const r = await uw(['set', 'old', 'plan:day1', '--note', 'Book the Alcázar tickets ahead.', '--json']);
  ok(r, 'set the note');
  assert.equal(r.json.shown, false);
  assert.equal(cfgOf('old').plan.days[0].note, 'Book the Alcázar tickets ahead.', 'kept with the day');
  const said = await uw(['set', 'old', 'plan:day2', '--note', 'Flamenco show at 7 pm.']);
  assert.match(said.out, /^Day 2 \(Sat 7 Nov · Seville\) has its note: "Flamenco show at 7 pm\.", but this map's page was made before day notes and does not show it: the reply says it is saved with day 2, not that the map shows it\.$/m);
  assert.doesNotMatch(said.out, /The Plan tab shows it/);
});

test('validate: a hosted turn is one turn, also when a long read between commands on the site restarts the pack\'s own clock', async () => {
  // the host's turn started before the map was built, and sets no deadline (a turn with no time limit)
  const hosted = { INSTAFY_TURN_STARTED_AT: new Date(Date.now() - 1000).toISOString(), UW_TURN_GAP: '1' };
  await runsMap('gap');
  // a read of pages that takes longer than the pack's idle gap, with no command on the site
  await new Promise((r) => setTimeout(r, 1500));
  const v = await uw(['validate', 'gap', '--json'], { env: hosted });
  assert.ok(staysError(v), `the places to stay this turn pinned still fail: ${JSON.stringify(v.json?.warnings, null, 1)}`);
  // the next turn: the host's start is after the map was built
  const later = await uw(['validate', 'gap', '--json'], { env: { ...hosted, INSTAFY_TURN_STARTED_AT: new Date(Date.now() + 1000).toISOString() } });
  assert.ok(!later.json.errors.some((e) => /places to stay|says why to stay/.test(e.message)), JSON.stringify(later.json.errors, null, 1));
  assert.ok(later.json.warnings.some((w) => /^places to stay: Seville/.test(w.message)));
});

// A map an older pack made: its days planned one sight each (uw plan now refuses that while the turn has time), and a
// sight whose page no uw cite read (uw add-point now refuses that). A later turn adds a note to a day: the note lands on
// its day and nothing else changes, and uw validate only warns about what the earlier turn left (its days are the
// person's; a page nobody read in this turn is not judged), so the map still loads as it was.
test('an old map, one sight a day and a page no uw cite read, still passes uw validate in a later turn and takes a day\'s note', async () => {
  const site = 'older';
  ok(await uw(['new', site, '--title', 'Three days in Seville', '--center', SANTA_CRUZ.join(','), '--zoom', '13']), 'new');
  ok(await uw(['add-point', site, '--layer', 'stops', '--query', 'Seville', '--country', 'ES', '--kind', 'city', '--id', 'seville', '--props', '{"nights":3}']), 'the stop');
  ok(await uw(['stay', site, '--near', SANTA_CRUZ.join(','), '--near-label', 'Santa Cruz', '--stop', 'seville', '--kinds', 'hotel']), 'stays');
  // as the older pack left it: three sights, the third citing a page nobody read, and the days planned one sight each
  const unread = 'https://www.example-guides.test/casa-de-pilatos';
  for (const [i, s] of SIGHTS.slice(0, 3).entries()) {
    ok(await uw(['add-point', site, '--layer', 'sights', '--at', s.c.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'],
      { input: JSON.stringify({ stop: 'seville', source_url: i === 2 ? unread : s.page, source: 'Wikipedia' }), env: i === 2 ? { UW_NO_CACHE: '1' } : {} }), s.name);
  }
  const plan = ['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights'];
  assert.equal((await uw(plan)).code, 2, 'this pack refuses one sight a day while the turn has time');
  ok(await uw(plan, { env: { UW_TURN_BUDGET: '100' } }), 'the days as they were planned');
  ok(await uw(['fit', site]), 'fit');
  assert.deepEqual(cfgOf(site).plan.days.map((d) => d.items.filter((it) => it.ref?.layer === 'sights').length), [1, 1, 1]);

  // the next turn, hours later as far as the map is concerned
  const now = Date.now() + 1000;
  fs.writeFileSync(path.join(tmp, site, '.uwcache', 'turn.json'), JSON.stringify({ started: now, last: now }));
  await new Promise((r) => setTimeout(r, 1100));
  const before = { cfg: cfgOf(site), sights: layerOf(site, 'sights') };
  const r = await uw(['set', site, 'plan:day1', '--note', 'Book the Alcázar tickets ahead.', '--json']);
  ok(r, 'the note');
  assert.deepEqual([r.json.day, r.json.note, r.json.shown], [1, 'Book the Alcázar tickets ahead.', true]);
  const cfg = cfgOf(site);
  assert.equal(cfg.plan.days[0].note, 'Book the Alcázar tickets ahead.');
  delete cfg.plan.days[0].note;
  assert.deepEqual(cfg, before.cfg, 'nothing else changed');
  assert.deepEqual(layerOf(site, 'sights'), before.sights);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  const days = v.json.warnings.filter((w) => w.path === '$.plan.days');
  assert.deepEqual(days.map((w) => w.message), ['3 of 3 full days have one place to see: Fri 6 Nov · Seville, Sat 7 Nov · Seville, Sun 8 Nov · Seville']);
  assert.match(days[0].fix, /^the days were planned in an earlier turn: keep what the person changed/);
  assert.deepEqual([...v.json.errors, ...v.json.warnings].filter((e) => e.path === '$.plan.sights'), [], 'a page an earlier turn gave is not judged unread');
});
