// Trip maps pinned what nobody asked for, pinned a business for a sight, and one had no days. A map of "3 days, with
// one day around <an area> and <a place>" marked two places the person never named as named (they stood in for the
// area); a sight's lookup took a hotel named after it ("Hotel Castle Garden" for a bazaar), a restaurant on the quay
// it was named after (the street was found first), and a shop for a market hall, and the turn then removed the hotel
// and forced the plan; a not-found bridge was listed twice (looked up as "<name>, <city>", then as "<name> <city>");
// and a map whose plan was refused for days short of places, by a turn that never planned again, had no Plan tab. An
// events map waited on each event's own page though the listing it read named each one. Now:
//  - the trip guide marks only a place whose own name the message says; an area it names is a day's theme;
//  - a sight's lookup refuses a hotel, a restaurant or a shop named after it (unless the lookup asks for that kind, or
//    its own name is the query's), saying what it found, and takes the place itself when the search lists it; a
//    place has one "not found yet" entry, whatever wording or id it was looked up again under;
//  - a refused plan on a map with no days yet writes the days as they are (a draft the next run replaces), so a turn
//    that replies next leaves its Plan tab; uw validate plans a draft again in its turn once its places change, and
//    names each short day;
//  - the skill takes a listing it read as each item's source, each item pinned by its venue.
// Offline: the place search, the lodging search and the walking router are a local mock in this file; every cache is
// off (no page is read).
// Run: node --test tests/named-kind-days.test.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-named-kind-days-'));

// ---------------------------------------------------------------------------
// The city and what the place search answers there (OpenStreetMap names, kinds and positions, in its answer shape)
const CITY = [-8.6109, 41.1496];
const RIBEIRA = [-8.6131, 41.1407];
const AREA = { city: 'Porto', county: 'Porto', state: 'Porto', country: 'Portugal', countrycode: 'PT' };
const off = (c, dx, dy) => [Math.round((c[0] + dx / 84000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const hit = (c, osm, name, more = {}) => {
  const [osm_type, osm_id, osm_key, osm_value] = osm;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { osm_type, osm_id, osm_key, osm_value, name, ...AREA, ...more } };
};
const ANSWERS = {
  // a hall whose only match is a hotel named after it
  'Bolhão Market Hall, Porto': [hit(off(CITY, 300, 400), ['N', 7001, 'tourism', 'hotel'], 'Hotel Bolhão Market')],
  // the quay, mapped as a street, first; then more of it, a bicycle park of its name, and a restaurant on it
  'Cais da Ribeira Porto': [
    hit(RIBEIRA, ['W', 7101, 'highway', 'pedestrian'], 'Cais da Ribeira'),
    hit(off(RIBEIRA, 40, 10), ['W', 7102, 'highway', 'living_street'], 'Cais da Ribeira'),
    hit(off(RIBEIRA, -60, 20), ['W', 7103, 'amenity', 'bicycle_parking'], 'Cais da Ribeira'),
    hit(off(RIBEIRA, 90, -30), ['N', 7104, 'amenity', 'restaurant'], 'O Cais da Ribeira'),
  ],
  // a market hall: a gift shop of its name in town, and the market of that name in another town
  'Mercado do Bolhão, Porto': [
    hit(off(CITY, 250, 350), ['N', 7201, 'shop', 'gift'], 'Lembranças do Mercado do Bolhão'),
    hit([-8.4265, 41.5503], ['W', 7202, 'amenity', 'marketplace'], 'Mercado do Bolhão', { city: 'Braga', county: 'Braga' }),
  ],
  // the venues of a listing's events
  'Praça da Ribeira, Porto': [hit(off(RIBEIRA, 120, 60), ['W', 7301, 'place', 'square'], 'Praça da Ribeira')],
  'Avenida dos Aliados, Porto': [hit(off(CITY, -40, 380), ['W', 7302, 'highway', 'pedestrian'], 'Avenida dos Aliados')],
};
// the lodging search's answer by the quay
const LODGING = [
  { type: 'node', id: 7401, c: off(RIBEIRA, 150, 80), tags: { tourism: 'hotel', name: 'Hotel do Cais' } },
  { type: 'node', id: 7402, c: off(RIBEIRA, -120, 200), tags: { tourism: 'hotel', name: 'Hotel da Ribeira' } },
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
      res.end(JSON.stringify({ type: 'FeatureCollection', features: u.searchParams.getAll('osm_tag').length ? [] : ANSWERS[q] || [] }));
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

// a turn's clock: by default the pack's own (a fresh turn: eight minutes for tool work); `clock` sets the host's
const uw = (args, { input = null, clock = null } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_VALHALLA: mock.url, UW_NO_CACHE: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_TURN_BUDGET', 'UW_TURN_GAP', 'UW_HANDOFF_STEP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
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
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const layerOf = (site, id) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${id}.geojson`), 'utf8')).features; } catch { return []; } };
const flat = (rel) => fs.readFileSync(path.join(SKILL, rel), 'utf8').replace(/\s+/g, ' ');

const newMap = async (site, more = []) => {
  const r = await uw(['new', site, '--title', 'Porto', '--ask', 'What to see', '--center', CITY.join(','), '--zoom', '13', ...more]);
  assert.equal(r.code, 0, r.out + r.err);
};
const newTrip = async (site) => {
  await newMap(site, ['--expect', 'Porto:3']);
  const stop = await uw(['add-point', site, '--layer', 'stops', '--at', CITY.join(','), '--name', 'Porto', '--kind', 'city', '--id', 'porto', '--props', '{"nights":3}']);
  assert.equal(stop.code, 0, stop.out + stop.err);
  const stays = await uw(['stay', site, '--near', RIBEIRA.join(','), '--near-label', 'Ribeira', '--stop', 'porto', '--kinds', 'hotel']);
  assert.equal(stays.code, 0, stays.out + stays.err);
};
// the trip's places to see, each with its own page, a few minutes' walk apart
const SIGHTS = [
  { id: 'se', name: 'Porto Cathedral', at: off(CITY, 60, -330), page: 'https://www.diocese-porto.pt/se' },
  { id: 'clerigos', name: 'Clérigos Tower', at: off(CITY, -380, -150), page: 'https://www.torredosclerigos.pt/en/' },
  { id: 'bolsa', name: 'Palácio da Bolsa', at: off(RIBEIRA, -150, 90), page: 'https://palaciodabolsa.com/en/' },
  { id: 'lello', name: 'Livraria Lello', at: off(CITY, -420, -40), page: 'https://www.livrarialello.pt/en' },
  { id: 'aliados', name: 'Avenida dos Aliados', at: off(CITY, -40, 380), page: 'https://www.cm-porto.pt/aliados' },
];
const pin = (site, s) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'],
  { input: JSON.stringify({ stop: 'porto', source_url: s.page, source: new URL(s.page).hostname.replace(/^www\./, ''), why: `see ${s.name}` }) });
const plan = (site, { force = false, clock = null } = {}) => uw(['plan', site, '--stops', 'stops', '--ids', 'porto', '--nights', '3', '--start', '2026-12-04',
  '--stays', 'stays', '--sights', 'sights', ...(force ? ['--force'] : []), '--json'], { clock });

// ---------------------------------------------------------------------------
test('the trip guide marks only a place whose own name the message says; an area it names is a day\'s theme', () => {
  const md = flat('reference/itinerary.md');
  assert.match(md, /3\. \*\*The places the message names\*\*, pinned first, each with `"asked":true` \(Phase B step 1\): only one whose own name the message says, never one you chose for an area it names\. Such an area \("a day around the old town"\) is a day's theme: that day's places come from it \(step 4\), unmarked, and its text starts with the area's name \(reword it after `uw plan`\)\. 4\. \*\*Places by area\*\*/);
  assert.doesNotMatch(md, /each with `"asked":true` \(Phase B step 1\); only those\./);
  // the config reference says what the mark is for in the same words
  assert.match(flat('reference/config.md'), /Only a place whose own name the message says is one: never one chosen for an area it names \(that area is a day's theme, its places unmarked\)\./);
});

const lookUp = (site, layer, query, id, more = []) => uw(['add-point', site, '--layer', layer, '--query', query, '--country', 'PT', '--near', CITY.join(','), '--id', id, ...more, '--json']);

test('a sight\'s lookup refuses a hotel named after it, saying what it found: nothing pinned, the place listed once as not found', async () => {
  const site = 'kinds-hotel';
  await newMap(site);
  const hall = await lookUp(site, 'sights', 'Bolhão Market Hall, Porto', 'market-hall', ['--strict-name']);
  assert.equal(hall.code, 2, hall.out + hall.err);
  assert.equal(hall.json.refused, 'named_after');
  assert.deepEqual(hall.json.found, { name: 'Hotel Bolhão Market', type: 'tourism=hotel', kind: 'lodging' });
  assert.match(hall.err, /^REFUSED: found a hotel named "Hotel Bolhão Market" \[tourism=hotel\], not the sight "Bolhão Market Hall" \(a hotel, a restaurant or a shop named after a place is not that place\):$/m);
  assert.match(hall.err, /^Retried once\? List it as unverified and add the next sight from the city page\.$/m);
  assert.deepEqual(layerOf(site, 'sights'), [], 'no hotel pinned as a sight');
  assert.deepEqual(cfgOf(site).missing.map((m) => [m.name, m.id]), [['Bolhão Market Hall', 'market-hall']]);
  // so no wrong pin needs removing: the map is valid as it is
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  // a pick of it is the turn's own choice, and takes its entry off
  const picked = await lookUp(site, 'sights', 'Bolhão Market Hall, Porto', 'market-hall', ['--pick', '1']);
  assert.equal(picked.code, 0, picked.out + picked.err);
  assert.equal(cfgOf(site).missing, undefined);
});

test('a quay is its street, never the restaurant on it; a lookup for food takes the restaurant', async () => {
  const site = 'kinds-quay';
  await newMap(site);
  // the street of the quay's name was found first: the restaurant within a few steps is not "the same place mapped twice"
  const quay = await lookUp(site, 'sights', 'Cais da Ribeira Porto', 'cais');
  assert.equal(quay.code, 0, quay.out + quay.err);
  assert.deepEqual([quay.json.chosen.name, quay.json.chosen.type], ['Cais da Ribeira', 'highway=pedestrian']);
  // a lookup that asks for that kind takes it: the restaurant on the quay is a food spot
  const food = await lookUp(site, 'food', 'Cais da Ribeira Porto', 'o-cais');
  assert.equal(food.code, 0, food.out + food.err);
  assert.deepEqual([food.json.chosen.name, food.json.chosen.type], ['O Cais da Ribeira', 'amenity=restaurant']);
});

test('a market hall whose only match nearby is a shop named after it is refused, saying what it found', async () => {
  const site = 'kinds-shop';
  await newMap(site);
  // (the market of that name is in another town, too far to be it)
  const market = await lookUp(site, 'sights', 'Mercado do Bolhão, Porto', 'bolhao');
  assert.equal(market.code, 2, market.out + market.err);
  assert.equal(market.json.refused, 'named_after');
  assert.deepEqual(market.json.found, { name: 'Lembranças do Mercado do Bolhão', type: 'shop=gift', kind: 'shop' });
  assert.match(market.err, /^REFUSED: found a shop named "Lembranças do Mercado do Bolhão" \[shop=gift\], not the sight "Mercado do Bolhão"/m);
  assert.deepEqual(layerOf(site, 'sights'), []);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.name), ['Mercado do Bolhão']);
});

test('a place has one "not found yet" entry, whatever wording or id it was looked up again under; a pin under either takes it off', async () => {
  const site = 'once';
  await newTrip(site);
  // the bridge, looked up as "<name>, <city>" and again as "<name> <city>" under another id: the search has neither
  for (const [query, id] of [['Ponte Luís I, Porto', 'ponte'], ['Ponte Luís I Porto', 'bridge']]) {
    const r = await uw(['add-point', site, '--layer', 'sights', '--query', query, '--country', 'PT', '--strict-name', '--near', CITY.join(','), '--id', id]);
    assert.equal(r.code, 2, r.out + r.err);
  }
  const missing = cfgOf(site).missing;
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.deepEqual([missing[0].name, missing[0].id, missing[0].also.map((a) => [a.id, a.name])], ['Ponte Luís I', 'ponte', [['bridge', 'Ponte Luís I Porto']]]);
  // the second lookup says so
  const again = await uw(['add-point', site, '--layer', 'sights', '--query', 'Ponte Luís I Porto', '--country', 'PT', '--strict-name', '--near', CITY.join(','), '--id', 'bridge']);
  assert.match(again.err, /Listed on the map as "not found yet" once \(map\.config\.json "missing"\), with "Ponte Luís I": the same place, looked up before\./);
  assert.deepEqual(cfgOf(site).missing.map((m) => m.also.length), [1], 'one entry, the later lookup kept on it once');
  // pinned under the second id (the coordinates the person gave): the one entry goes, and validate finds none beside it
  const pinned = await uw(['add-point', site, '--layer', 'sights', '--at', off(RIBEIRA, 400, -60).join(','), '--name', 'Luís I Bridge', '--id', 'bridge']);
  assert.equal(pinned.code, 0, pinned.out + pinned.err);
  assert.match(pinned.out, /removed its "not found yet" entry/);
  assert.equal(cfgOf(site).missing, undefined);
});

test('a refused plan leaves the days as they are on a map with none, so a reply right after it has the Plan tab; uw validate plans the draft again with the places pinned since, naming each short day', async () => {
  const site = 'days';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 2)) assert.equal((await pin(site, s)).code, 0);
  // refused (two places for three days, while the turn has time): the map still gets the days, as they are
  const refused = await plan(site);
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.equal(refused.json.refused, 'days_short_of_places');
  assert.equal(refused.json.draft, true);
  assert.deepEqual(refused.json.short_days.map((d) => d.title), ['Fri 4 Dec · Porto', 'Sat 5 Dec · Porto', 'Sun 6 Dec · Porto']);
  // each day named, the short one as it is ("nothing to see yet"), for a reply that cannot wait
  assert.equal(refused.json.days_for_the_reply, 'Fri 4 Dec · Porto: nothing to see yet | Sat 5 Dec · Porto: Porto Cathedral | Sun 6 Dec · Porto: Clérigos Tower');
  assert.match(refused.err, /^REFUSED: 3 of 3 full days would have fewer than 2 places to see with their own page \(a full day takes 2-3\): .*\. The days are on the map as they are for now: a draft, which this command replaces\.$/m);
  // the last step before a reply: the Plan tab is there, each day on it
  const drafted = cfgOf(site).plan;
  assert.deepEqual(drafted.days.map((d) => d.title), ['Fri 4 Dec · Porto', 'Sat 5 Dec · Porto', 'Sun 6 Dec · Porto']);
  assert.equal(drafted.draft.start, '2026-12-04');
  // the next run replaces a draft without --force
  const rerun = await plan(site);
  assert.equal(rerun.code, 2, rerun.out + rerun.err);
  assert.doesNotMatch(rerun.err, /already has a "plan"/);

  // a place pinned after the draft, then validate last: the days are planned again with it, still a draft, and
  // validate names the days still short
  assert.equal((await pin(site, SIGHTS[2])).code, 0);
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.json.planned_again.draft, true);
  assert.ok(v.json.planned_again.days_for_the_reply.includes('Palácio da Bolsa'), v.json.planned_again.days_for_the_reply);
  const onDays = cfgOf(site).plan.days.flatMap((d) => d.items.filter((it) => it.ref?.layer === 'sights').map((it) => it.ref.id)).sort();
  assert.deepEqual(onDays, ['bolsa', 'clerigos', 'se']);
  assert.equal(v.code, 1, 'the days still short fail while the turn has time');
  assert.ok(v.json.errors.some((e) => e.path === '$.plan.days' && /^3 of 3 full days have one place to see \(a full day takes 2-3 sourced places\): Fri 4 Dec · Porto, Sat 5 Dec · Porto, Sun 6 Dec · Porto$/.test(e.message)),
    JSON.stringify(v.json.errors, null, 1));
  const text = await uw(['validate', site, '--signal']);
  assert.doesNotMatch(text.out, /Days planned again/, 'nothing changed since: not planned again');

  // with too little time left, a place more: planned again as they are (no draft), each short day named for the reply
  const late = hostClock(450);
  assert.equal((await pin(site, SIGHTS[3])).code, 0);
  const last = await uw(['validate', site, '--signal', '--json'], { clock: late });
  assert.equal(last.code, 0, JSON.stringify(last.json?.errors ?? last.out, null, 1));
  assert.equal(last.json.planned_again.draft, false);
  assert.equal(cfgOf(site).plan.draft, undefined);
  const w = last.json.warnings.filter((x) => x.path === '$.plan.days');
  assert.equal(w.length, 1, JSON.stringify(last.json.warnings, null, 1));
  assert.match(w[0].message, /^2 of 3 full days have one place to see: /);
  assert.equal(w[0].fix, 'too little time is left to add places in this turn; the reply names these days and offers to add places to them');
});

test('a draft is planned again only in the turn that wrote it, and a map whose days are already there keeps them when a plan is refused', async () => {
  const site = 'later';
  await newTrip(site);
  for (const s of SIGHTS.slice(0, 2)) assert.equal((await pin(site, s)).code, 0);
  assert.equal((await plan(site)).code, 2);
  const before = cfgOf(site).plan;
  // a later turn: the draft's days are the map's as they are (the person may have changed them)
  assert.equal((await pin(site, SIGHTS[2])).code, 0);
  const v = await uw(['validate', site, '--signal', '--json'], { clock: hostClock(0) });
  assert.equal(v.json.planned_again, undefined);
  assert.deepEqual(cfgOf(site).plan.days, before.days);
  // days written as they are (no draft), then a refused plan: they stay as they were, nothing written
  assert.equal((await plan(site, { force: true, clock: hostClock(450) })).code, 0);
  const final = cfgOf(site).plan;
  assert.equal(final.draft, undefined);
  const refused = await plan(site, { force: true });
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.equal(refused.json.draft, undefined);
  assert.match(refused.err, /^REFUSED: .*\. Nothing was written\.$/m);
  assert.deepEqual(cfgOf(site).plan, final);
});

test('a listing read is each item\'s source: the skill pins each by its venue, cited to the listing, and opens an item\'s own page only for what was asked', async () => {
  assert.match(flat('SKILL.md'), /A listing read \(what's on\) is each item's source: pin it by its venue \(`--query "<venue>" --name "<item>"`, the date in `note`\); its own page only for what was asked that it lacks\./);
  // as it says: two events of one listing, each at its venue, both citing the listing; the map's sources name it
  const site = 'whats-on';
  await newMap(site);
  const listing = 'https://www.visitporto.travel/en/events';
  for (const [venue, name, id, when] of [['Praça da Ribeira, Porto', 'Christmas Market', 'market', 'Sat 5 – Sun 6 Dec'], ['Avenida dos Aliados, Porto', 'New Year Concert', 'concert', 'Thu 31 Dec, 22:00']]) {
    const r = await uw(['add-point', site, '--layer', 'events', '--query', venue, '--country', 'PT', '--near', CITY.join(','), '--name', name, '--id', id, '--props-file', '-'],
      { input: JSON.stringify({ source_url: listing, source: 'Visit Porto', note: when }) });
    assert.equal(r.code, 0, r.out + r.err);
  }
  const events = layerOf(site, 'events');
  assert.deepEqual(events.map((f) => [f.properties.name, f.properties.looked_up_as, f.properties.source_url, f.properties.note]), [
    ['Christmas Market', 'Praça da Ribeira', listing, 'Sat 5 – Sun 6 Dec'], ['New Year Concert', 'Avenida dos Aliados', listing, 'Thu 31 Dec, 22:00']]);
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.match(v.json.sources_for_the_reply, /Visit Porto/);
});
