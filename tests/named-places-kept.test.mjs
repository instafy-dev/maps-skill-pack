// Two trip maps pinned their sights from place lookups, then cited guessed pages of the city's tourism site, which
// answered HTTP 404 (one) or were refused by its robots.txt (the other). `uw plan --sights` refused the days ("fewer
// than 2 places to see with their own page") and told the turn to give each pinned place "the page uw cite read for
// it", with no way to find one. Six seconds later one turn removed all seven sights it had pinned, the two the person
// had named among them ("one day around …"), planned cafés instead, and replied with the day the person asked for
// while its last `uw validate` failed: the map no longer had that day. Now:
//  - a place pinned with no page stays on its day, counted, marked not checked, as a place the person named ("asked":
//    true) does (`uw set` takes the mark off once it has its page): the refusal names only a day still short of
//    places and where to add one, never a place's page to count it, and `uw validate` warns of each place not
//    checked for the reply (a turn planned its days again without such places to get past the refusal, and every day
//    was empty);
//  - `uw plan` prints the days for the reply as the map has them, and a failing `uw validate` says a reply sent before
//    it passes says plainly what is undone; the skill and its references never tell a turn to remove a place to pass a
//    check, and the trip guide's reply takes its days from `uw plan`.
// And:
//  - a place the person named is never left off the days while a day has a place of its kind they did not name, and
//    `uw validate` fails while one is on no day;
//  - a place whose page is not its own (one city page for several, a page that does not name it), taken with too
//    little time left, is "(not checked)" in the days for the reply and marked so on the Plan tab, as is every place
//    with no page; `uw validate` never calls a day with such places one with nothing to see;
//  - the refusal never offers to mark places as named to get past it;
//  - `uw set --remove` refuses a place the person named unless the same command takes the mark off, and its help says
//    when a place is removed; a mark given after the days were planned reaches the days;
//  - no line the tools print tells a turn to remove a place pinned to see (validate's far-from-the-view fix did), and
//    the lines a turn meets first (uw cite's 404 and robots.txt refusals, validate's fixes) name the reference search.
// Offline: the lodging search, the walking router and the tourism site are a local mock in this file (uw cite reads
// 127.0.0.1 with UW_ALLOW_LOCAL=1); the pages the turn finds are kept as uw cite keeps what it read, in this test's
// own cache, as in a space.
// Run: node --test tests/named-places-kept.test.mjs
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
const { daysForReply, groupByArea, NOT_CHECKED } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-plan.mjs')).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-named-places-'));
// what uw cite read, kept the way it keeps it (this test's own shared cache)
delete process.env.UW_NO_CACHE;
process.env.UW_CACHE = path.join(tmp, 'cache');
const { rememberCited } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'cmd-cite.mjs')).href);
const read = (url, text) => rememberCited([url], { url, title: '', retrieved_at: new Date().toISOString(), text });

// ---------------------------------------------------------------------------
// The two trips, with the positions OpenStreetMap has. The first: "3 days, one around <two places the person named>"
const VIENNA = { stop: [16.372504, 48.208354], area: 'central Vienna' };
const NAMED = [
  { id: 'naschmarkt', name: 'Naschmarkt', at: [16.362622, 48.19818] },
  { id: 'secession', name: 'Secession', at: [16.365768, 48.200497] },
];
const CHOSEN = [
  { id: 'stephansdom', name: 'Stephansdom', at: [16.373127, 48.208492] },
  { id: 'hofburg', name: 'Hofburg', at: [16.365626, 48.206329] },
  { id: 'schonbrunn', name: 'Schloss Schönbrunn', at: [16.311568, 48.184989] },
  { id: 'belvedere', name: 'Oberes Belvedere', at: [16.380888, 48.191542] },
  { id: 'kunsthistorisches', name: 'Kunsthistorisches Museum', at: [16.361782, 48.20374] },
];
// the second: "2 days, what to see each day", with nothing named
const LJUBLJANA = { stop: [14.506929, 46.050027], area: 'Ljubljana city centre' };
const CASTLE = { id: 'castle', name: 'Ljubljanski grad', at: [14.508538, 46.048782], page: 'https://castle.example/en/' };
const WIKI = 'https://en.wikipedia.org/wiki/';

const off = (c, dx, dy) => [Math.round((c[0] + dx / 75000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const LODGING = [
  { type: 'node', id: 4234525389, c: [16.371632, 48.208374], tags: { tourism: 'hotel', name: 'DO&CO Hotel' } },
  { type: 'node', id: 701, c: off(VIENNA.stop, 250, -150), tags: { tourism: 'hotel', name: 'Hotel Royal' } },
  { type: 'node', id: 9762842264, c: [14.506533, 46.049269], tags: { tourism: 'hotel', name: 'Old Quarter Residence' } },
  { type: 'node', id: 702, c: off(LJUBLJANA.stop, 200, 150), tags: { tourism: 'hotel', name: 'Vander Urbani Resort' } },
];
// the city tourism site, at the mock's address: its guessed sight pages are gone (HTTP 404), and its listing of sights
// is closed to agents by its robots.txt
const PAGES = { '/robots.txt': 'User-agent: *\nDisallow: /en/visitors/\n' };
let mock;
const hits = { pages: [] };
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
    if (u.pathname === '/api/' || u.pathname === '/api' || u.pathname === '/reverse') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'FeatureCollection', features: [] }));
      return;
    }
    hits.pages.push(u.pathname);
    if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(PAGES[u.pathname]); return; }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>Page not found</body></html>');
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
    UW_VALHALLA: mock.url, UW_ALLOW_LOCAL: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_HANDOFF_STEP', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
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
const sightIds = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', 'sights.geojson'), 'utf8')).features.map((f) => f.properties.id);
const itemsOf = (day) => day.items.filter((it) => it.ref?.layer === 'sights');

/** Steps the turns took: the map with its stop, its places to stay, then each sight pinned with no page. */
const trip = async (site, { title, city, at, nights, area, stop }) => {
  assert.equal((await uw(['new', site, '--title', title, '--ask', 'Where to stay and what to see', '--center', at.join(','), '--zoom', '13', '--expect', `${city}:${nights}`])).code, 0);
  const s = await uw(['add-point', site, '--layer', 'stops', '--at', at.join(','), '--name', city, '--kind', 'city', '--id', stop, '--props', JSON.stringify({ nights })]);
  assert.equal(s.code, 0, s.out + s.err);
  const stays = await uw(['stay', site, '--near', at.join(','), '--near-label', area, '--stop', stop, '--kinds', 'hotel']);
  assert.equal(stays.code, 0, stays.out + stays.err);
};
const pin = (site, s, props) => uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'], { input: JSON.stringify(props) });
const planVienna = (more = [], opts = {}, site = 'vienna') => uw(['plan', site, '--stops', 'stops', '--ids', 'vienna', '--nights', '3', '--start', '2026-11-18', '--stays', 'stays', '--sights', 'sights', ...more, '--force'], opts);
const viennaPinned = async (site) => {
  await trip(site, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  // the two places the person named, marked so; the others the turn chose; none has a page yet
  for (const s of NAMED) assert.equal((await pin(site, s, { stop: 'vienna', asked: true })).code, 0);
  for (const s of CHOSEN) assert.equal((await pin(site, s, { stop: 'vienna' })).code, 0);
  // the guessed pages of the city's tourism site are gone
  for (const id of ['secession', 'naschmarkt']) {
    const gone = await uw(['cite', `${mock.url}/en/see-do/sights/${id}`, '--grep', id]);
    assert.equal(gone.code, 1, gone.out + gone.err);
    assert.match(gone.err, /HTTP 404 \(page missing or gone: do not cite it\)/);
  }
};
const search = (name) => `instafy web search "${name}" --chain reference-search --json`;

// ---------------------------------------------------------------------------
test('places pinned with no page stay on their days, counted and marked not checked, as the places the person named do: the refusal names only a day still short; then the plan and validate pass', async () => {
  const site = 'vienna';
  await viennaPinned(site);
  const all = [...NAMED, ...CHOSEN].map((s) => s.id);
  // every place counts on its day, with or without its page: only the palace's day a ride out, with one place, is short
  const refused = await planVienna(['--json']);
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.deepEqual(refused.json.short_days, [{ title: 'Fri 20 Nov · Vienna', places: 1 }]);
  assert.equal(refused.json.draft, true, 'the days as they are, a draft for now');
  assert.equal(cfgOf(site).plan.draft.start, '2026-11-18');
  assert.deepEqual(sightIds(site), all, 'every place stays pinned');
  // the draft has every place on a day, marked not checked; the refusal asks for no place's page to count it
  assert.deepEqual(cfgOf(site).plan.days.map((d) => itemsOf(d).length), [3, 3, 1]);
  for (const d of cfgOf(site).plan.days) for (const it of itemsOf(d)) assert.equal(it.check, NOT_CHECKED, it.text);
  assert.equal(refused.json.no_page, undefined);
  assert.equal(refused.json.instead, undefined);
  // one more near the palace a ride out, whose day it is
  assert.deepEqual(refused.json.add, [{ name: 'Schloss Schönbrunn', near: '16.311568,48.184989', stop: 'vienna', places: 1 }]);
  const text = await planVienna();
  assert.equal(text.code, 2);
  assert.deepEqual(text.err.trim().split('\n'), [
    'REFUSED: 1 of 3 full days would have fewer than 2 places to see (a full day takes 2-3): Fri 20 Nov · Vienna (1). The days are on the map as they are for now: a draft, which this command replaces.',
    'Add 1 more place near Schloss Schönbrunn (--near 16.311568,48.184989), each from its own page '
      + '(its own site from instafy web search "<its name>" --chain reference-search --json, else its Wikipedia article): uw cite <that page> --grep "<its name>", '
      + 'then uw add-point vienna --layer sights --near 16.311568,48.184989 … with {"stop":"vienna","source_url":"<that page>","source":"<site>"}, '
      + 'one place per command (reference/itinerary.md Phase B step 1). Then run this command again.',
    'Looked for more after this refusal and none could be added (no other place found there, or none with a page of its own)? Run this command again as it is: a day with one place to see is then kept, as a warning the reply names.']);
  // marking places as named is never offered as a way past it
  assert.doesNotMatch(text.err + refused.json.next, /asked/);
  assert.equal(text.json, null);
  assert.equal(refused.json.next, text.err.trim().split('\n').slice(1).join('\n'));

  // pages for four of them (their Wikipedia articles), read with uw cite, then given with uw set
  const wiki = { stephansdom: 'St._Stephen%27s_Cathedral,_Vienna', hofburg: 'Hofburg', belvedere: 'Belvedere,_Vienna', schonbrunn: 'Sch%C3%B6nbrunn_Palace' };
  for (const [id, page] of Object.entries(wiki)) {
    const url = `${WIKI}${page}`;
    read(url, `${CHOSEN.find((s) => s.id === id).name}\nOpening hours and tickets.`);
    const set = await uw(['set', site, `sights:${id}`, '--props-file', '-'], { input: JSON.stringify({ source_url: url, source: 'Wikipedia' }) });
    assert.equal(set.code, 0, set.out + set.err);
  }
  // and one more place near the palace, from its own page
  const zoo = `${WIKI}Tiergarten_Sch%C3%B6nbrunn`;
  read(zoo, 'Tiergarten Schönbrunn\nThe zoo in the palace park.');
  assert.equal((await pin(site, { id: 'tiergarten', name: 'Tiergarten Schönbrunn', at: [16.30245, 48.18233] }, { stop: 'vienna', source_url: zoo, source: 'Wikipedia' })).code, 0);

  const planned = await planVienna(['--json']);
  assert.equal(planned.code, 0, planned.out + planned.err);
  assert.deepEqual(sightIds(site), [...all, 'tiergarten'], 'no place was removed');
  const days = cfgOf(site).plan.days;
  // the places the person named sit together on one day, counted there, marked not checked (no page was read)
  const theirs = days.filter((d) => itemsOf(d).some((it) => it.asked));
  assert.equal(theirs.length, 1);
  const named = itemsOf(theirs[0]).filter((it) => it.asked);
  assert.deepEqual(named.map((it) => [it.ref.id, it.check, it.url]), [['secession', NOT_CHECKED, undefined], ['naschmarkt', NOT_CHECKED, undefined]]);
  // the days for the reply, as the map has them: each day's places, the ones with no page said so
  assert.equal(planned.json.days_for_the_reply, daysForReply(cfgOf(site).plan));
  assert.equal(planned.json.days_for_the_reply, 'Wed 18 Nov · Vienna: Stephansdom, Hofburg, Oberes Belvedere | '
    + 'Thu 19 Nov · Vienna: Kunsthistorisches Museum (not checked), Secession (not checked), Naschmarkt (not checked) | '
    + 'Fri 20 Nov · Vienna: Schloss Schönbrunn, Tiergarten Schönbrunn');
  const plain = await planVienna();
  assert.equal(plain.code, 0, plain.out + plain.err);
  assert.ok(plain.out.includes(`Days for the reply, as the map has them (no other place; one not checked is said so): ${planned.json.days_for_the_reply}.`), plain.out);
  // validate passes, and warns of the places on the days that are not checked, for the reply to name
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.deepEqual(v.json.warnings.filter((w) => w.path === '$.plan.days').map((w) => w.message),
    ['3 places on the days are not checked on a page of their own: Kunsthistorisches Museum (Thu 19 Nov), Secession (Thu 19 Nov), Naschmarkt (Thu 19 Nov)']);

  // a named place's page found later: its item links it, and the mark goes; the day keeps it
  const own = 'https://market.example/';
  read(own, 'Naschmarkt\nThe market by the river.');
  assert.equal((await uw(['set', site, 'sights:naschmarkt', '--props-file', '-'], { input: JSON.stringify({ source_url: own, source: 'naschmarkt' }) })).code, 0);
  const after = itemsOf(cfgOf(site).plan.days.find((d) => d.title === theirs[0].title)).find((it) => it.ref.id === 'naschmarkt');
  assert.deepEqual([after.url, after.check, after.asked], [own, undefined, true]);
});

test('with too little time left the days are written as they are: every place stays on its day, not checked, and validate warns of each for the reply', async () => {
  const site = 'vienna-late';
  await viennaPinned(site);
  const turn = hostClock(450);
  const written = await uw(['plan', site, '--stops', 'stops', '--ids', 'vienna', '--nights', '3', '--start', '2026-11-18', '--stays', 'stays', '--sights', 'sights', '--json'], { clock: turn });
  assert.equal(written.code, 0, written.out + written.err);
  assert.deepEqual(sightIds(site), [...NAMED, ...CHOSEN].map((s) => s.id));
  const day = cfgOf(site).plan.days.find((d) => itemsOf(d).some((it) => it.asked));
  assert.deepEqual(itemsOf(day).filter((it) => it.asked).map((it) => [it.text, it.check]), [['Secession', NOT_CHECKED], ['Naschmarkt', NOT_CHECKED]]);
  assert.equal(written.json.days_for_the_reply, 'Wed 18 Nov · Vienna: Stephansdom (not checked), Hofburg (not checked), Oberes Belvedere (not checked) | '
    + 'Thu 19 Nov · Vienna: Kunsthistorisches Museum (not checked), Secession (not checked), Naschmarkt (not checked) | Fri 20 Nov · Vienna: Schloss Schönbrunn (not checked)');
  // validate fails none of the days for it: every place is on its day, marked not checked, and it warns of each for
  // the reply, with the day that has one place to see
  const v = await uw(['validate', site, '--signal', '--json'], { clock: turn });
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  assert.deepEqual(v.json.errors.filter((e) => e.path === '$.plan.days'), []);
  assert.deepEqual(v.json.warnings.filter((w) => w.path === '$.plan.days').map((w) => w.message), [
    '7 places on the days are not checked on a page of their own: Stephansdom (Wed 18 Nov), Hofburg (Wed 18 Nov), Oberes Belvedere (Wed 18 Nov), Kunsthistorisches Museum (Thu 19 Nov) …',
    '1 of 3 full days have one place to see: Fri 20 Nov · Vienna']);
  // the Plan tab marks every place with no page of its own, as the days for the reply do
  for (const d of cfgOf(site).plan.days) for (const it of itemsOf(d)) assert.equal(it.check, NOT_CHECKED, it.text);
  const text = await uw(['validate', site, '--signal'], { clock: turn });
  assert.equal(text.code, 0);
  assert.match(text.out, /^✓ vienna-late is valid \(\d+ warning\(s\)\)\.$/m);
});

test('a trip whose tourism listing refuses agents: the refusal says where each new place\'s page comes from; then the plan and validate pass', async () => {
  const site = 'ljubljana';
  await trip(site, { title: 'Ljubljana: first visit', city: 'Ljubljana', at: LJUBLJANA.stop, nights: 2, area: LJUBLJANA.area, stop: 'ljubljana' });
  // the castle from its own site; the tourism site's listing of sights is closed to agents
  read(CASTLE.page, 'Ljubljana Castle (Ljubljanski grad)\nTickets and opening hours.');
  assert.equal((await pin(site, CASTLE, { stop: 'ljubljana', source_url: CASTLE.page, source: 'Ljubljana Castle' })).code, 0);
  const listing = await uw(['cite', `${mock.url}/en/visitors/sights-and-activities/`, '--grep', 'Dragon Bridge']);
  assert.equal(listing.code, 2, listing.out + listing.err);
  assert.match(listing.out + listing.err, /robots\.txt disallows/);
  // planned one a day, as the turn did: the day with nothing is refused, with where a new place's page comes from
  const plan = (more = []) => uw(['plan', site, '--stops', 'stops', '--ids', 'ljubljana', '--nights', '2', '--start', '2026-11-18', '--stays', 'stays', '--sights', 'sights', '--per-day', '1', ...more, '--force']);
  const refused = await plan();
  assert.equal(refused.code, 2, refused.out + refused.err);
  const [first, next, ...rest] = refused.err.trim().split('\n');
  assert.match(first, /^REFUSED: 1 of 2 full days would have no place to see \(one a day: --per-day 1\): Wed 18 Nov · Ljubljana \(0\)\. The days are on the map as they are for now: a draft, which this command replaces\.$/);
  assert.match(next, /^Add 1 more place near the base, Old Quarter Residence \(--near 14\.506533,46\.049269\), each from its own page \(its own site from instafy web search "<its name>" --chain reference-search --json, else its Wikipedia article\): uw cite <that page> --grep "<its name>", then uw add-point ljubljana --layer sights /);
  assert.deepEqual(rest, ['A full day with nothing to see is refused again while the turn has time: each takes a place first. With too little time left the days are written as they are, and the reply names each.']);
  // as it says: a place from its Wikipedia article
  const bridge = `${WIKI}Dragon_Bridge_(Ljubljana)`;
  read(bridge, 'Dragon Bridge\nA road bridge over the Ljubljanica.');
  assert.equal((await pin(site, { id: 'dragon-bridge', name: 'Dragon Bridge', at: [14.510254, 46.052194] }, { stop: 'ljubljana', source_url: bridge, source: 'Wikipedia' })).code, 0);
  const planned = await plan(['--json']);
  assert.equal(planned.code, 0, planned.out + planned.err);
  assert.equal(planned.json.days_for_the_reply, 'Wed 18 Nov · Ljubljana: Ljubljanski grad | Thu 19 Nov · Ljubljana: Dragon Bridge');
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
});

test('the days for the reply: each full day\'s places, one with no page "(not checked)", a full day with none "nothing to see yet"', () => {
  const plan = { sights: ['sights', 'food'], days: [
    { title: 'Mon 2 Nov · A', items: [{ text: 'Base: Hotel · 2 min walk to A', ref: { layer: 'stays', id: 'h' }, url: 'https://www.openstreetmap.org/node/1' }, { text: 'Museum', ref: { layer: 'sights', id: 'm' }, url: 'https://museum.example/' }, { text: 'Market', ref: { layer: 'food', id: 'k' }, asked: true, check: NOT_CHECKED }] },
    { title: 'Tue 3 Nov · A', items: [] },
    { title: 'Wed 4 Nov · A → B', items: [{ text: '🚆 A → B', ref: { layer: 'legs', id: 'l' } }] },
    { title: 'Thu 5 Nov · B: depart', depart: true, items: [] },
  ] };
  assert.equal(daysForReply(plan), 'Mon 2 Nov · A: Museum, Market (not checked) | Tue 3 Nov · A: nothing to see yet');
  // a page that is not its own, taken with too little time left: its item links it and is marked, and the reply says so
  plan.days[1].items.push({ text: 'Square', ref: { layer: 'sights', id: 's' }, url: 'https://guide.example/top', source: 'guide', check: NOT_CHECKED });
  assert.equal(daysForReply(plan), 'Mon 2 Nov · A: Museum, Market (not checked) | Tue 3 Nov · A: Square (not checked)');
  plan.days[1].items.pop();
  assert.equal(daysForReply({ days: plan.days }), 'Mon 2 Nov · A: nothing to see yet | Tue 3 Nov · A: nothing to see yet', 'no --sights: no places to name');
});

test('the skill and its references never tell a turn to remove a place to pass a check; the trip guide keeps what the person named and takes the reply\'s days from uw plan', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const docs = [path.join(SKILL, 'SKILL.md'), ...walk(path.join(SKILL, 'reference')).filter((f) => f.endsWith('.md'))];
  const flat = (f) => fs.readFileSync(f, 'utf8').replace(/\s+/g, ' ');
  // every sentence that removes a place is the one for when the person asks
  const removing = docs.flatMap((f) => flat(f).split(/(?<=\.) (?=[A-Z-])/).filter((s) => /--remove\b|\b(remove|drop|delete)s? (a|the|that|this|each|every) (place|sight|pin)/i.test(s)).map((s) => [path.relative(SKILL, f), s]));
  assert.ok(removing.length >= 1, 'the trip guide still says how to drop a place the person asks to drop');
  for (const [f, s] of removing) assert.match(s, /only when the person asks|Never remove a place/, `${f}: ${s}`);
  const md = flat(path.join(SKILL, 'reference', 'itinerary.md'));
  assert.match(md, /- Dropping a place, only when the person asks: `uw set <site> <layer>:<id> --remove` \(one they named: `--unset asked --remove`\), then remove its item and reword its day's text\. Never remove a place the person named, or one pinned to see, to get past a refusal or a failing check: it gets its own page \(Phase B step 1\), and one the person named stays on its day as it is \(`"asked":true`: `uw plan` counts it, marked not checked while no page was read\)\./);
  // the places the message names are a step of their own, pinned first and marked, and only those: a place whose own
  // name the message says, never one chosen for an area it names
  assert.match(md, /3\. \*\*The places the message names\*\*, pinned first, each with `"asked":true` \(Phase B step 1\): only one whose own name the message says, never one you chose for an area it names\. [^#]*? 4\. \*\*Places by area\*\*/);
  assert.match(md, /2-3 sourced places in it \(Phase B step 1, with `"stop":"<slug>"`\)\. Never put a place on a day/);
  assert.match(md, /The places the message names come first, each with `"asked":true` in its props: `uw plan` keeps it on its day as the person gave it, marked not checked until its own page is read \(never a place you chose\)\. Then each sight in a command of its own/);
  assert.match(md, /The reply \("Reply", at the end\): the stay with its dates and days as `uw plan` prints them, the `Assumed:` line \(the dates too, when the person gave none\), where to stay and why\./);
  assert.match(md, /5\. Each day as `uw plan` printed it \("Days for the reply": no place it does not name; one not checked is said so\), with highlights or warnings worth acting on \(a closure, a pass to buy\) only from the pages you opened\. When the time ran out with `uw validate` failing, or naming a full day with one place to see, say plainly what is missing, as the last `uw plan` and `uw validate` name it \("<day> has nothing to see yet", "<day> has one place to see", "no days yet: <day> needs one more place", "<place> is not checked yet", "<place> you named is on no day"\), never with a cause they do not give\. Never ask the person to add a place: say which day is short and offer to add one\./);
  // the plan's help and the config reference say what "asked" does
  const config = flat(path.join(SKILL, 'reference', 'config.md'));
  assert.match(config, /`"asked": true` is a place the person's message named, given when it is pinned or later with `uw set` \(only that, never to get past a check; `uw plan` and `uw set` copy it to its items\): it counts for its day as an item with a `url` does, `uw plan` never leaves it off the days while a day has a place of its kind nobody named, and `uw set` refuses to remove it unless the same command has `--unset asked`\./);
  assert.match(config, /A place with no page of its own \(none, or one taken with too little time left that is not its own\) gets `"check": "on a page of its own"` in its days, which `uw set` takes off once it has its own page\./);
});

// ---------------------------------------------------------------------------
// What else keeps a place the person named, and says plainly what is not checked, each with the steps that showed it.

test('a place the person named is never left off the days while a day has a place of its kind they did not name; validate fails while one is on no day', async () => {
  const site = 'vienna-full';
  await trip(site, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  // nine places with their own pages, three areas of three: as many as three days hold; then the two the person named
  const areas = [VIENNA.stop, [16.311568, 48.184989], [16.395, 48.216]];
  let n = 0;
  for (const c of areas) for (const [dx, dy] of [[0, 0], [150, 100], [-120, 140]]) {
    n += 1;
    const url = `https://place${n}.example/`;
    read(url, `Place ${n}\nOpening hours.`);
    assert.equal((await pin(site, { id: `p${n}`, name: `Place ${n}`, at: off(c, dx, dy) }, { stop: 'vienna', source_url: url, source: `place${n}` })).code, 0);
  }
  for (const s of NAMED) assert.equal((await pin(site, s, { stop: 'vienna', asked: true })).code, 0);
  const planned = await planVienna(['--json'], {}, site);
  assert.equal(planned.code, 0, planned.out + planned.err);
  const { plan } = cfgOf(site);
  // both are on a day, together (they are a few steps apart), and two places the turn chose make room
  const day = plan.days.find((d) => itemsOf(d).some((it) => it.ref.id === 'naschmarkt'));
  assert.ok(day && itemsOf(day).some((it) => it.ref.id === 'secession'), JSON.stringify(plan.days.map((d) => itemsOf(d).map((it) => it.ref.id))));
  assert.equal(plan.unplaced.length, 2);
  assert.ok(plan.unplaced.every((r) => /^sights:p\d$/.test(r)), plan.unplaced.join(', '));
  assert.match(planned.json.days_for_the_reply, /Secession \(not checked\)/);
  assert.match(planned.json.days_for_the_reply, /Naschmarkt \(not checked\)/);
  const plain = await planVienna([], {}, site);
  assert.match(plain.out, /^Not on any day \(each day already has --per-day 3 of their kind\): Place \d, Place \d\. Add nights, raise --per-day, or leave them out of the reply\.$/m);
  assert.doesNotMatch(plain.out, /Places the person named, on no day/);
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));

  // more places named than three days of three hold: the one left over is said, never left out of the reply
  const ten = 'vienna-ten';
  await trip(ten, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  const more = [1, 2, 3].map((k) => ({ id: `named-${k}`, name: `Named place ${k}`, at: off(VIENNA.stop, 300 * k, -200 * k) }));
  for (const s of [...NAMED, ...CHOSEN, ...more]) assert.equal((await pin(ten, s, { stop: 'vienna', asked: true })).code, 0);
  const full = await planVienna(['--json'], {}, ten);
  assert.equal(full.code, 0, full.out + full.err);
  assert.equal(full.json.named_not_on_plan.length, 1);
  const name = [...NAMED, ...CHOSEN, ...more].find((s) => `sights:${s.id}` === full.json.named_not_on_plan[0]).name;
  const said = await planVienna([], {}, ten);
  assert.ok(said.out.split('\n').includes(`Places the person named, on no day: ${name} (each day already has --per-day 3 places they named of its kind). Never leave one out: run this command again with --per-day 4.`), said.out);
  assert.doesNotMatch(said.out, /leave them out of the reply/);
  const failing = await uw(['validate', ten, '--signal', '--json']);
  assert.equal(failing.code, 1, failing.out);
  assert.deepEqual(failing.json.errors.filter((e) => e.path === '$.plan.days').map((e) => [e.message, e.fix]), [[`a place the person named is on no day: ${name}`,
    `uw plan ${ten} … --sights sights --per-day 4 (one far from every stop: uw set ${ten} <layer>:<id> --props '{"stop":"<its stop id>"}' first); with too little time left, the reply says plainly which is on no day`]]);
  // with too little time left it is a warning, which the reply says
  const late = await uw(['validate', ten, '--signal', '--json'], { clock: hostClock(450) });
  assert.deepEqual(late.json.warnings.filter((w) => /person named/.test(w.message)).map((w) => w.message), [`a place the person named is on no day: ${name}`]);
  // as the fix says
  const four = await planVienna(['--per-day', '4', '--json'], {}, ten);
  assert.equal(four.code, 0, four.out + four.err);
  assert.equal(four.json.named_not_on_plan, undefined);
  const ok = await uw(['validate', ten, '--signal', '--json']);
  assert.deepEqual(ok.json.errors.filter((e) => /person named/.test(e.message)), []);

  // one far from every stop, pinned with no stop: said too, with its fix
  const away = 'vienna-away';
  await trip(away, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 1, area: VIENNA.area, stop: 'vienna' });
  for (const s of NAMED) assert.equal((await pin(away, s, { stop: 'vienna', asked: true })).code, 0);
  assert.equal((await pin(away, { id: 'abbey', name: 'Abbey up the river', at: [15.334, 48.2283] }, { asked: true })).code, 0);
  const planOne = (more = []) => uw(['plan', away, '--stops', 'stops', '--ids', 'vienna', '--nights', '1', '--start', '2026-11-18', '--stays', 'stays', '--sights', 'sights', '--force', ...more]);
  const farOff = await planOne();
  assert.equal(farOff.code, 0, farOff.out + farOff.err);
  assert.ok(farOff.out.split('\n').includes(`Places the person named, on no day: Abbey up the river (far from every stop). Never leave one out: give one far from every stop its stop (uw set ${away} <layer>:<id> --props '{"stop":"<its stop id>"}'), then run this command again.`), farOff.out);
  assert.deepEqual((await uw(['validate', away, '--signal', '--json'])).json.errors.filter((e) => /person named/.test(e.message)).map((e) => e.message), ['a place the person named is on no day: Abbey up the river']);
  assert.equal((await uw(['set', away, 'sights:abbey', '--props', '{"stop":"vienna"}'])).code, 0);
  const placed = await planOne(['--json']);
  assert.equal(placed.code, 0, placed.out + placed.err);
  assert.equal(placed.json.named_not_on_plan, undefined);
  assert.match(placed.json.days_for_the_reply, /Abbey up the river \(not checked\)/);
});

test('groupByArea: a place the person named takes the room of the nearest day\'s place nobody named, never the room of another named place', () => {
  const at = (id, c, asked = false) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, ...(asked ? { asked: true } : {}) }, _layer: 'sights' });
  // two full areas and a place the person named in neither: it takes the room of the nearer area's farthest place
  const a = [16.37, 48.21], b = [16.31, 48.185];
  const feats = [at('a1', a), at('a2', off(a, 100, 0)), at('a3', off(a, 0, 120)), at('b1', b), at('b2', off(b, 100, 0)), at('b3', off(b, 0, 120)), at('named', off(a, 900, 900), true)];
  const days = groupByArea(feats, 2, 3);
  const ids = days.map((d) => d.map((f) => f.properties.id));
  assert.ok(ids.flat().includes('named'), JSON.stringify(ids));
  assert.deepEqual(ids.find((d) => d.includes('named')).sort(), ['a2', 'a3', 'named']);
  // places the person named only: the last one has no room, and nobody named the others
  const all = [at('n1', a, true), at('n2', b, true), at('n3', off(a, 100, 0), true)];
  assert.deepEqual(groupByArea(all, 2, 1).map((d) => d.map((f) => f.properties.id)).flat().sort(), ['n1', 'n2']);
});

test('with too little time left, a place whose page is not its own is "(not checked)" in the days for the reply and on the Plan tab, as validate tells the reply; its own page takes the mark off', async () => {
  const site = 'vienna-guide';
  const turn = hostClock(450);
  await trip(site, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  // one city guide page names six of them; the seventh cites a page that does not name it
  const guide = 'https://guide.example/top-sights';
  const tickets = 'https://guide.example/tickets';
  const places = [...NAMED, ...CHOSEN];
  read(guide, ['Top sights', ...places.filter((s) => s.id !== 'schonbrunn').map((s) => s.name)].join('\n'));
  read(tickets, 'Tickets and passes for the city.');
  for (const s of places) {
    const page = s.id === 'schonbrunn' ? tickets : guide;
    const r = await uw(['add-point', site, '--layer', 'sights', '--at', s.at.join(','), '--name', s.name, '--id', s.id, '--props-file', '-'],
      { input: JSON.stringify({ stop: 'vienna', source_url: page, source: 'guide' }), clock: turn });
    assert.equal(r.code, 0, r.out + r.err); // taken this late, and said
  }
  const planned = await uw(['plan', site, '--stops', 'stops', '--ids', 'vienna', '--nights', '3', '--start', '2026-11-18', '--stays', 'stays', '--sights', 'sights', '--json'], { clock: turn });
  assert.equal(planned.code, 0, planned.out + planned.err);
  const named = planned.json.days_for_the_reply.split(' | ').flatMap((d) => d.slice(d.indexOf(': ') + 2).split(', '));
  assert.equal(named.length, 7, planned.json.days_for_the_reply);
  for (const p of named) assert.match(p, / \(not checked\)$/, planned.json.days_for_the_reply);
  // the Plan tab links each page and says it is not checked on a page of its own
  for (const d of cfgOf(site).plan.days) for (const it of itemsOf(d)) assert.deepEqual([it.check, typeof it.url], [NOT_CHECKED, 'string'], it.text);
  // what validate tells the reply, for the same places
  const v = await uw(['validate', site, '--signal', '--json'], { clock: turn });
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors));
  assert.deepEqual(v.json.warnings.filter((w) => w.path === '$.plan.sights').map((w) => w.fix), [
    'too little time is left to cite their own pages in this turn; the reply names these places as not checked on a page of their own',
    'too little time is left to cite their own pages in this turn; the reply names these places as not checked on a page of their own']);
  // its own page, given with time left: the mark goes, the day keeps it
  const own = 'https://cathedral.example/';
  read(own, 'Stephansdom\nOpening hours.');
  assert.equal((await uw(['set', site, 'sights:stephansdom', '--props-file', '-'], { input: JSON.stringify({ source_url: own, source: 'cathedral' }) })).code, 0);
  const item = () => cfgOf(site).plan.days.flatMap(itemsOf).find((it) => it.ref.id === 'stephansdom');
  assert.deepEqual([item().url, item().check], [own, undefined]);
  // a page that is not its own again, taken with too little time left: marked again
  const again = await uw(['set', site, 'sights:stephansdom', '--props-file', '-'], { input: JSON.stringify({ source_url: guide, source: 'guide' }), clock: hostClock(450) });
  assert.equal(again.code, 0, again.out + again.err);
  assert.match(again.out, /links that page now, marked not checked; the days are as they were\./);
  assert.deepEqual([item().url, item().check], [guide, NOT_CHECKED]);
});

test('a day whose places have no page to find is no short day: the plan passes at once, and they stay on their day, not checked, named for the reply', async () => {
  const site = 'vienna-unfound';
  await viennaPinned(site);
  // a page for every place but two on the first day, which the search found nothing for
  for (const s of CHOSEN.filter((x) => !['hofburg', 'belvedere'].includes(x.id))) {
    const url = `${WIKI}${s.id}`;
    read(url, `${s.name}\nOpening hours.`);
    assert.equal((await uw(['set', site, `sights:${s.id}`, '--props-file', '-'], { input: JSON.stringify({ source_url: url, source: 'Wikipedia' }) })).code, 0);
  }
  const zoo = `${WIKI}Tiergarten_Sch%C3%B6nbrunn`;
  read(zoo, 'Tiergarten Schönbrunn\nThe zoo in the palace park.');
  assert.equal((await pin(site, { id: 'tiergarten', name: 'Tiergarten Schönbrunn', at: [16.30245, 48.18233] }, { stop: 'vienna', source_url: zoo, source: 'Wikipedia' })).code, 0);
  // the day of the two with no page has three places: the plan is written, nothing refused, nothing to add instead
  const planned = await planVienna(['--json'], {}, site);
  assert.equal(planned.code, 0, planned.out + planned.err);
  assert.deepEqual(sightIds(site), [...NAMED, ...CHOSEN].map((s) => s.id).concat('tiergarten'), 'every place stays pinned');
  for (const id of ['hofburg', 'belvedere']) {
    const it = cfgOf(site).plan.days.flatMap(itemsOf).find((x) => x.ref.id === id);
    assert.equal(it?.check, NOT_CHECKED, id);
  }
  assert.match(planned.json.days_for_the_reply, /Hofburg \(not checked\)/);
  assert.match(planned.json.days_for_the_reply, /Oberes Belvedere \(not checked\)/);
  const v = await uw(['validate', site, '--signal', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.errors ?? v.out, null, 1));
  const unchecked = v.json.warnings.find((w) => /are not checked on a page of their own/.test(w.message));
  assert.match(unchecked.message, /Hofburg \(Wed 18 Nov\), Oberes Belvedere \(Wed 18 Nov\)/);
  assert.match(unchecked.fix, /^the reply names each as not checked \("<place> is not checked yet"\); while the turn has time, each from its own page /);
});

test('uw set --remove refuses a place the person named unless the same command takes its mark off; one place pinned twice keeps the mark on the pin that stays; the help says when a place is removed', async () => {
  const site = 'vienna-drop';
  await trip(site, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  assert.equal((await pin(site, NAMED[0], { stop: 'vienna', asked: true })).code, 0);
  const refused = await uw(['set', site, 'sights:naschmarkt', '--remove', '--json']);
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.deepEqual(refused.json, { ok: false, refused: 'named_by_the_person', layer: 'sights', id: 'naschmarkt', next: 'uw set vienna-drop sights:naschmarkt --unset asked --remove' });
  assert.deepEqual(sightIds(site), ['naschmarkt'], 'nothing was changed');
  const text = await uw(['set', site, 'sights:naschmarkt', '--remove']);
  assert.deepEqual(text.err.trim().split('\n'), [
    'REFUSED: "Naschmarkt" is a place the person named: it stays on the map and on its day, marked not checked while it has no page of its own. Nothing was changed.',
    'Never remove it to get past a refusal or a failing check. Its own page: its own site from instafy web search "<its name>" --chain reference-search --json, else its Wikipedia article; '
      + 'uw cite <that page> --grep "<its name>", then uw set vienna-drop sights:naschmarkt --props-file - with {"source_url":"<that page>","source":"<site>"}.',
    'Only when the person asks to drop it: uw set vienna-drop sights:naschmarkt --unset asked --remove']);
  // one place pinned twice (its other pin a few steps away): removing the named pin keeps the place, and the mark
  const file = path.join(tmp, site, 'data', 'sights.geojson');
  const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const twin = JSON.parse(JSON.stringify(fc.features[0]));
  delete fc.features[0].properties.asked;
  twin.properties.id = 'naschmarkt-2';
  twin.geometry.coordinates = off(twin.geometry.coordinates, 20, 0);
  fc.features.push(twin);
  fs.writeFileSync(file, JSON.stringify(fc));
  assert.equal((await uw(['set', site, 'sights:naschmarkt-2', '--remove'])).code, 0);
  const left = JSON.parse(fs.readFileSync(file, 'utf8')).features;
  assert.deepEqual(left.map((f) => [f.properties.id, f.properties.asked]), [['naschmarkt', true]]);
  // the person asks to drop it
  const dropped = await uw(['set', site, 'sights:naschmarkt', '--unset', 'asked', '--remove']);
  assert.equal(dropped.code, 0, dropped.out + dropped.err);
  assert.deepEqual(sightIds(site), []);
  const help = await uw(['set', '--help']);
  assert.match(help.out.replace(/\s+/g, ' '), /removes it \(--remove: only a place the person asks to drop, never one they named or one pinned to see to get past a refusal or a failing check; one they named, "asked": true, is refused unless the same command has --unset asked\)/);
});

test('a place marked as one the person named after the days were planned reaches its items; the mark taken off undoes it; a day of places with no page is never one with nothing to see', async () => {
  const site = 'vienna-marked';
  const turn = hostClock(450);
  await trip(site, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  for (const s of [...NAMED, ...CHOSEN]) assert.equal((await pin(site, s, { stop: 'vienna' })).code, 0);
  const planned = await uw(['plan', site, '--stops', 'stops', '--ids', 'vienna', '--nights', '3', '--start', '2026-11-18', '--stays', 'stays', '--sights', 'sights', '--json'], { clock: turn });
  assert.equal(planned.code, 0, planned.out + planned.err);
  const bare = async () => (await uw(['validate', site, '--signal', '--json'], { clock: turn })).json.errors.filter((e) => e.path === '$.plan.days').map((e) => e.message);
  assert.deepEqual(await bare(), [], 'every day has its places, not checked');
  const set = await uw(['set', site, 'sights:naschmarkt', '--props', '{"asked":true}'], { clock: turn });
  assert.equal(set.code, 0, set.out + set.err);
  assert.match(set.out, /Its item in the plan's days counts for its day as a place the person named; the days are as they were\./);
  const item = () => cfgOf(site).plan.days.flatMap(itemsOf).find((it) => it.ref.id === 'naschmarkt');
  assert.deepEqual([item().asked, item().check], [true, NOT_CHECKED]);
  assert.deepEqual(await bare(), []);
  assert.equal((await uw(['set', site, 'sights:naschmarkt', '--unset', 'asked'], { clock: turn })).code, 0);
  assert.deepEqual([item().asked, item().check], [undefined, NOT_CHECKED]);
  assert.deepEqual(await bare(), []);
});

test('no line the tools print tells a turn to remove a place pinned to see: validate\'s fix for a place far out of the first view pins it again or frames it', async () => {
  const site = 'vienna-view';
  await trip(site, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  for (const s of NAMED) assert.equal((await pin(site, s, { stop: 'vienna', asked: true })).code, 0);
  for (const s of CHOSEN) assert.equal((await pin(site, s, { stop: 'vienna' })).code, 0);
  const v = await uw(['validate', site, '--signal', '--json']);
  const far = v.json.errors.find((e) => /far outside view\.bounds/.test(e.message));
  assert.match(far?.message || '', /"schonbrunn"/, JSON.stringify(v.json.errors));
  assert.equal(far.fix, 'a wrong geocode match or swapped lng/lat: pin it again under its own id with --near <its area\'s lng,lat> or --pick (it replaces the pin, and the days that name it keep it); '
    + 'the place meant, out of the first view (a palace or a day trip out of the centre): uw fit vienna-view. Never remove a place pinned to see to pass this');
  // as the fix says, a wrong match pinned again under its own id somewhere else: a place the person named stays one
  assert.equal((await pin(site, { id: 'naschmarkt', name: 'Naschmarkt', at: off(NAMED[0].at, 0, -900) }, { stop: 'vienna' })).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', 'sights.geojson'), 'utf8')).features.find((f) => f.properties.id === 'naschmarkt').properties.asked, true);
  // every line of the tools that gives a removal says when: the person asks, or one place pinned twice keeps a pin
  const lib = path.join(SKILL, 'scripts', 'lib');
  const said = fs.readdirSync(lib).filter((f) => f.endsWith('.mjs')).flatMap((f) => fs.readFileSync(path.join(lib, f), 'utf8').split('\n')
    .filter((l) => /--remove\b/.test(l) && !/^\s*(\/\/|\*|\/\*\*)/.test(l)).map((l) => [f, l.trim()]));
  assert.ok(said.length >= 3, 'the lines are found');
  for (const [f, l] of said) assert.match(l, /only a place the person asks|Only when the person asks|\bnext = `uw set .* --unset asked --remove`|one place, one pin|\[--remove\]|args\.remove|'remove'/, `${f}: ${l}`);
});

test('the lines a turn meets first name the reference search for a place\'s own page: uw cite\'s 404 and robots.txt refusals, add-point\'s refusal of a page it could not read, and validate\'s fixes', async () => {
  const way = 'its own site from instafy web search "<its name>" --chain reference-search --json, else its Wikipedia article';
  const gone = await uw(['cite', `${mock.url}/en/see-do/sights/secession`, '--grep', 'Secession']);
  assert.equal(gone.code, 1);
  assert.ok(gone.err.includes(`HTTP 404 (page missing or gone: do not cite it). For a place, cite its own page instead: ${way}.`), gone.err);
  const listing = await uw(['cite', `${mock.url}/en/visitors/sights-and-activities/`, '--grep', 'Dragon Bridge', '--json']);
  assert.equal(listing.code, 2);
  assert.ok(listing.json.tell.startsWith(`This URL only: give the user the plain link and try a different source (for a place: ${way}).`), listing.json.tell);
  const said = await uw(['cite', `${mock.url}/en/visitors/sights-and-activities/`, '--grep', 'Dragon Bridge']);
  assert.ok(said.out.includes(`For a place, its own page: ${way}.`), said.out);
  // a guessed page that answered 404 is refused as a source, with the way to its own page
  const site = 'vienna-ways';
  await trip(site, { title: 'Vienna: first visit', city: 'Vienna', at: VIENNA.stop, nights: 3, area: VIENNA.area, stop: 'vienna' });
  const refused = await pin(site, NAMED[1], { stop: 'vienna', source_url: `${mock.url}/en/see-do/sights/secession`, source: 'city' });
  assert.equal(refused.code, 2, refused.out + refused.err);
  assert.ok(refused.err.includes(`could not be read (HTTP 404: the page is missing or gone): it is not this place's source. Give it its own page instead (${way})`), refused.err);
  // late, with the plan's refusal not run, validate's fixes are what the turn reads
  for (const s of [...NAMED, ...CHOSEN]) assert.equal((await pin(site, s, { stop: 'vienna' })).code, 0);
  assert.equal((await planVienna([], { clock: hostClock(450) }, site)).code, 0);
  const v = await uw(['validate', site, '--signal', '--json']);
  const bare = v.json.errors.find((e) => e.path === '$.plan.days');
  assert.ok(bare.fix.includes(`each from its own page (${way})`), bare.fix);
});
