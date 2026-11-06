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
const uw = (args, { input = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
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
 *  with a note no page said, six sights from their own pages, and the plan. */
async function runsMap(site) {
  ok(await uw(['new', site, '--title', 'Three days in Seville', '--ask', 'Where to stay and what to see each day', '--center', SANTA_CRUZ.join(','), '--zoom', '13']), 'new');
  ok(await uw(['add-point', site, '--layer', 'stops', '--query', 'Seville', '--country', 'ES', '--kind', 'city', '--id', 'seville', '--props', '{"nights":3}']), 'the stop');
  ok(await uw(['add-point', site, '--layer', 'stays', '--query', 'Santa Cruz, Seville', '--near', SANTA_CRUZ.join(','), '--id', 'santa-cruz-area', '--kind', 'area', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'seville', note: 'Recommended base area for first-time visitors; historic centre location.' }) }), 'the area');
  for (const s of SIGHTS) {
    ok(await uw(['add-point', site, '--layer', 'sights', '--query', s.name, '--country', 'ES', '--strict-name', '--near', SANTA_CRUZ.join(','), '--id', s.id, '--props-file', '-'],
      { input: JSON.stringify({ stop: 'seville', source_url: s.page, source: 'Wikipedia' }) }), s.name);
  }
  ok(await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-06', '--stays', 'stays', '--sights', 'sights']), 'plan');
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
  assert.match(stays.fix, /None found \(exit 2 after widening, or exit 4\): the area is the recommendation, its note from a page you read, and the reply says places to stay were not looked up yet$/);
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
  assert.deepEqual(r.json, { ok: true, day: 1, title: 'Fri 6 Nov · Seville', note: 'Book the Alcázar tickets ahead.', changed: ['note'] });
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
  assert.match(trip, /`uw validate` fails while a stop's only stay is an area and `uw stay` has not looked there, or while an area's note cites no page `uw cite` read\./);
  assert.match(trip, /- A note for a day \("add a note to day 1: book the tickets ahead"\): `uw set <site> plan:day1 --note "<the note>"`, the day's own line under its text in the Plan tab/);
  const help = await uw(['set', '--help']);
  assert.match(help.out, /^set <dir> plan:day<N> --note "…" \| --unset note \[--json\]$/m);
});
