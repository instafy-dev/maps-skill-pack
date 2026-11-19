// A "3 days in Seville" turn ran `uw cite` on the Alcázar's /en/ page (HTTP 404), then pinned the Alcázar with the
// site's home page as its source, which no uw cite had read. `uw validate` named it at the end of the turn ("1 place
// cites a page no uw cite read"), with almost seven minutes left, and the turn replied with the map unfinished. The
// check runs at the step that can fix it: `uw add-point` and `uw set` judge a place's page as uw cite read it. A page
// no uw cite read used to be refused ("cite it first"): a trip's turn then cited each page and pinned again, a round
// trip a place, and its last pin was refused so as its time ran out. Now they read it themselves, as uw cite would
// (and keep it, as uw cite does), before any lookup; one that cannot be read (HTTP 404) is refused with why (nothing
// added or changed, and the place is not "not found yet"). With every cache off (UW_NO_CACHE) nothing read is kept, so
// nothing is read or refused; a step `uw handoff --apply` runs itself is judged by the handoff's own source check.
// Offline: the place search and the site are a local mock in this file (uw cite reads 127.0.0.1 with UW_ALLOW_LOCAL=1).
// Run: node --test tests/cite-first.test.mjs
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
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-cite-first-'));

const CITY = [-5.99534, 37.38863];
const ALCAZAR = { type: 'Feature', geometry: { type: 'Point', coordinates: [-5.990183, 37.383211] },
  properties: { osm_type: 'W', osm_id: 22747187, osm_key: 'historic', osm_value: 'castle', name: 'Real Alcázar de Sevilla', city: 'Sevilla', country: 'España', countrycode: 'ES' } };
const PAGES = {
  '/': '<html><head><title>Real Alcázar de Sevilla</title></head><body><h1>Real Alcázar de Sevilla</h1><p>The royal palace of Seville.</p></body></html>',
  '/visit/': '<html><head><title>Visit | Real Alcázar de Sevilla</title></head><body><p>Tickets for the Real Alcázar de Sevilla.</p></body></html>',
};

let mock;
const hits = { search: 0, pages: [] };
before(async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nAllow: /\n'); return; }
    if (u.pathname === '/api/' || u.pathname === '/api') {
      hits.search++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'FeatureCollection', features: /Alc[aá]zar/.test(u.searchParams.get('q') || '') ? [ALCAZAR] : [] }));
      return;
    }
    hits.pages.push(u.pathname);
    // a photo of the palace, not a page
    if (u.pathname === '/patio.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])); return; }
    if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGES[u.pathname]); return; }
    // the site's /en/ page is gone
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>Not found</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mock = { server, url: `http://127.0.0.1:${server.address().port}` };
});
after(() => {
  mock?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// what uw cite reads is kept in this test's own shared cache (the cache on, as in a space)
const uw = (args, { input = null, env: extra = {} } = {}) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_OSRM: mock.url,
    UW_ALLOW_LOCAL: '1', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookups.json'), UW_RETRY_PAUSE_MS: '0' };
  for (const k of ['UW_NO_CACHE', 'UW_HANDOFF_STEP', 'UW_TURN_BUDGET', 'UW_TURN_GAP', 'INSTAFY_CACHE_DIR', 'INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'INSTAFY_JOB_DEADLINE', 'UW_RUN_ID']) delete env[k];
  Object.assign(env, extra);
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(input ?? '');
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const sightsFile = (site) => path.join(tmp, site, 'data', 'sights.geojson');
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const addAlcazar = (site, url, more = [], opts = {}) => uw(['add-point', site, '--layer', 'sights', '--query', 'Real Alcázar de Sevilla', '--country', 'ES', '--strict-name', '--near', CITY.join(','),
  '--id', 'alcazar', ...more, '--props-file', '-'], { input: JSON.stringify({ stop: 'seville', source_url: url, source: 'alcazarsevilla.org', why: 'the royal palace' }), ...opts });

test('uw add-point reads a source_url no uw cite read itself, as uw cite would, and pins the place; a page it cannot read (HTTP 404) is refused before any lookup, with why', async () => {
  const site = 'sv';
  assert.equal((await uw(['new', site, '--title', '3 days in Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  const home = `${mock.url}/`, gone = `${mock.url}/en/`;

  // the /en/ page, never read: read now, as uw cite would; it is gone (HTTP 404), so it is refused, and nothing is
  // looked up or written
  const four = await addAlcazar(site, gone, ['--json']);
  assert.equal(four.code, 2, four.out + four.err);
  assert.deepEqual(four.json, { ok: false, refused: 'source_not_read', layer: 'sights', id: 'alcazar', source_url: gone, why: 'HTTP 404: the page is missing or gone',
    next: 'uw cite <its own page> --grep "Real Alcázar de Sevilla"' });
  assert.deepEqual(four.err.trim().split('\n'), [
    `REFUSED: ${gone} could not be read (HTTP 404: the page is missing or gone): it is not this place's source. Give it its own page instead (its own site from instafy web search "<its name>" --chain reference-search --json, else its Wikipedia article): run this command again with that page as its source_url, and it reads that page (to see what a page says first: uw cite <its own page> --grep "Real Alcázar de Sevilla").`,
    'Nothing was added.',
  ]);
  assert.deepEqual(hits.pages, ['/en/'], 'the page was read once');
  assert.equal(hits.search, 0, 'no lookup ran');
  assert.equal(fs.existsSync(sightsFile(site)), false, 'nothing was written');
  assert.equal(cfgOf(site).missing, undefined, 'the place is not "not found yet": it was never looked up');

  // the home page, never read: read in the same command, then the place is looked up and pinned with it, with no
  // "cite it first" round trip
  const ok = await addAlcazar(site, home, ['--json']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.ok(ok.err.includes(`Read ${home} for "Real Alcázar de Sevilla", as uw cite would (127.0.0.1 · "Real Alcázar de Sevilla").`), ok.err);
  assert.doesNotMatch(ok.err, /REFUSED|cite it first/);
  assert.equal(ok.json.source_not_named, undefined, 'the page names it');
  const [f] = JSON.parse(fs.readFileSync(sightsFile(site), 'utf8')).features;
  assert.deepEqual([f.properties.id, f.properties.source_url], ['alcazar', home]);
  assert.ok(hits.search > 0, 'the lookup runs once the page was read');
  // what it read is kept as uw cite keeps it: the same page again is not read again
  const pages = hits.pages.length;
  assert.equal((await addAlcazar(site, home)).code, 0);
  assert.equal(hits.pages.length, pages, 'no second request');
});

test('uw set reads a new source_url no uw cite read itself and takes it; one it cannot read is refused, nothing changed', async () => {
  const site = 'sv-set';
  assert.equal((await uw(['new', site, '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  assert.equal((await uw(['add-point', site, '--layer', 'sights', '--at', '-5.990183,37.383211', '--name', 'Real Alcázar', '--id', 'alcazar'])).code, 0);
  const visit = `${mock.url}/visit/`, gone = `${mock.url}/visit/tickets-gone/`;
  // a page that is gone: read, refused with why, the place as it was
  const before = fs.readFileSync(sightsFile(site), 'utf8');
  const s = await uw(['set', site, 'sights:alcazar', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: gone, source: 'alcazarsevilla.org' }) });
  assert.equal(s.code, 2, s.out + s.err);
  assert.deepEqual(s.json, { ok: false, refused: 'source_not_read', layer: 'sights', id: 'alcazar', source_url: gone, why: 'HTTP 404: the page is missing or gone', next: 'uw cite <its own page> --grep "Real Alcázar"' });
  assert.match(s.err, /^REFUSED: \S+ could not be read \(HTTP 404: the page is missing or gone\): it is not this place's source\. Give it its own page instead/m);
  assert.match(s.err, /Nothing was changed\.$/m);
  assert.equal(fs.readFileSync(sightsFile(site), 'utf8'), before, 'nothing was changed');
  // a note, or another prop, is no source: set as ever, and reads nothing
  const pages = hits.pages.length;
  assert.equal((await uw(['set', site, 'sights:alcazar', '--note', 'Book ahead.'])).code, 0);
  assert.equal(hits.pages.length, pages);
  // a page that is there: read in the same command, then taken
  const ok = await uw(['set', site, 'sights:alcazar', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: visit, source: 'alcazarsevilla.org' }) });
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.deepEqual(ok.json.changed, ['source_url', 'source']);
  assert.ok(ok.err.includes(`Read ${visit} for "Real Alcázar", as uw cite would (127.0.0.1 · "Visit | Real Alcázar de Sevilla").`), ok.err);
  assert.equal(hits.pages.length, pages + 1, 'read once');
  // the same page again: nothing to read or change
  assert.equal((await uw(['set', site, 'sights:alcazar', '--props-file', '-'], { input: JSON.stringify({ source_url: visit, source: 'alcazarsevilla.org' }) })).code, 0);
  assert.equal(hits.pages.length, pages + 1);
});

// uw cite read an address that is not a page (a photo): it exits 2, "not a page … it is not the source of anything", and
// keeps it as such. A place that cites it was pinned with a warning and failed only uw validate, at the end of the turn:
// now it is refused at once, as a page nobody read is, with the place's own page to cite instead (nothing added or
// changed)
test('uw add-point and uw set refuse a source uw cite found is not a page (an image), naming what it is; nothing added or changed', async () => {
  const site = 'sv-photo';
  assert.equal((await uw(['new', site, '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  const photo = `${mock.url}/patio.jpg`;
  const cite = await uw(['cite', photo, '--grep', 'Alcázar']);
  assert.equal(cite.code, 2, cite.out + cite.err);
  assert.match(cite.out, /not a page: it is an image \(image\/jpeg\)/);
  const search = hits.search;
  const add = await addAlcazar(site, photo, ['--json']);
  assert.equal(add.code, 2, add.out + add.err);
  assert.deepEqual(add.json, { ok: false, refused: 'source_not_a_page', layer: 'sights', id: 'alcazar', source_url: photo, next: 'uw cite <its own page> --grep "Real Alcázar de Sevilla"' });
  assert.deepEqual(add.err.trim().split('\n'), [
    `REFUSED: ${photo} (read by uw cite) is an image (image/jpeg), not a page that names "Real Alcázar de Sevilla": it is not this place's source. Cite its own page first (its own site from instafy web search "<its name>" --chain reference-search --json, else its Wikipedia article), then run this command again with that page as its source_url:`,
    '  uw cite <its own page> --grep "Real Alcázar de Sevilla"',
    'Nothing was added.',
  ]);
  assert.equal(hits.search, search, 'no lookup ran');
  assert.equal(fs.existsSync(sightsFile(site)), false, 'nothing was written');
  // uw set the same: refused, the place as it was
  assert.equal((await uw(['add-point', site, '--layer', 'sights', '--at', '-5.990183,37.383211', '--name', 'Real Alcázar', '--id', 'alcazar'])).code, 0);
  const before = fs.readFileSync(sightsFile(site), 'utf8');
  const set = await uw(['set', site, 'sights:alcazar', '--props-file', '-', '--json'], { input: JSON.stringify({ source_url: photo, source: 'alcazarsevilla.org' }) });
  assert.equal(set.code, 2, set.out + set.err);
  assert.deepEqual([set.json.refused, set.json.source_url, set.json.next], ['source_not_a_page', photo, 'uw cite <its own page> --grep "Real Alcázar"']);
  assert.match(set.err, /^Nothing was changed\.$/m);
  assert.equal(fs.readFileSync(sightsFile(site), 'utf8'), before, 'nothing was changed');
});

test('with every cache off nothing read is kept, so nothing is read or refused; a uw handoff --apply step is judged by the handoff\'s source check', async () => {
  const site = 'sv-off';
  assert.equal((await uw(['new', site, '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  const off = await addAlcazar(site, `${mock.url}/never-read/`, [], { env: { UW_NO_CACHE: '1' } });
  assert.equal(off.code, 0, off.out + off.err);
  const step = await uw(['add-point', site, '--layer', 'food', '--at', '-6.002979,37.386201', '--name', 'Mercado de Triana', '--id', 'triana', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'seville', source_url: `${mock.url}/not-read-either/`, source: 'mercadodetriana.com' }), env: { UW_HANDOFF_STEP: '1' } });
  assert.equal(step.code, 0, step.out + step.err);
  // the turn's own command with the same page reads it: it is gone (HTTP 404), so it is refused
  const own = await uw(['add-point', site, '--layer', 'food', '--at', '-6.002979,37.386201', '--name', 'Mercado de Triana', '--id', 'triana', '--props-file', '-'],
    { input: JSON.stringify({ stop: 'seville', source_url: `${mock.url}/not-read-either/`, source: 'mercadodetriana.com' }) });
  assert.equal(own.code, 2, own.out + own.err);
  assert.match(own.err, /could not be read \(HTTP 404: the page is missing or gone\)/);
});

// Where what uw cite reads cannot be kept (a cache folder this process may not write, as in a sandbox that allows
// writes only in its workspace), uw cite still reads, but nothing it read is found again: a page it read would be
// refused as unread, and every place with a page with it. As with every cache off, nothing is refused there
test('where nothing uw cite reads can be kept, a page it read is not refused as unread', { skip: process.getuid?.() === 0 ? 'root writes a read-only folder' : false }, async () => {
  const site = 'sv-kept';
  assert.equal((await uw(['new', site, '--title', 'Seville', '--center', CITY.join(','), '--zoom', '13'])).code, 0);
  const locked = path.join(tmp, 'locked-cache');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o555);
  try {
    const env = { UW_CACHE: locked };
    const home = `${mock.url}/`;
    assert.equal((await uw(['cite', home, '--grep', 'Real Alcázar'], { env })).code, 0);
    const add = await addAlcazar(site, home, [], { env });
    assert.equal(add.code, 0, add.out + add.err);
    assert.doesNotMatch(add.err, /REFUSED/);
  } finally { fs.chmodSync(locked, 0o755); }
});

test('the skill, the trip guide and the commands\' help say a place\'s page is read before it is pinned, by add-point and set themselves when no uw cite read it', async () => {
  const flat = (f) => fs.readFileSync(path.join(SKILL, f), 'utf8').replace(/\s+/g, ' ');
  assert.match(flat('SKILL.md'), /On exit 2 retry once \(better `--query`, `--pick N`, `--osm <id>`\), unless "already pinned": it is on the map, never pin it again\. Still not found: keep going/);
  for (const f of ['SKILL.md', 'reference/itinerary.md', 'reference/data-sources.md']) assert.doesNotMatch(flat(f), /cite it first/i, f);
  assert.match(flat('reference/itinerary.md'), /`uw add-point` and `uw set` read a `source_url` no `uw cite` read themselves, as it would, and refuse one they cannot read, one that does not name the place or that another place cites \("cite its own page"\)/);
  // a pin's page is read with uw cite, in Instafy too, where facts are read with instafy web read: the skill's rule for
  // reading, the sources reference and a later change's places say so, so no page is fetched twice
  assert.match(flat('SKILL.md'), /Facts come from pages you read \(`instafy web read <url>`, skill `instafy-web-research`; a pin's `source_url` and else: `uw cite <url> --grep <what>`\)/);
  assert.match(flat('reference/data-sources.md'), /A pin's `source_url` is a page `uw cite` read, in Instafy too: `uw add-point` and `uw set` read one no `uw cite` read themselves, the same way, and refuse one they cannot read; an image or a PDF is no page\./);
  assert.match(flat('reference/itinerary.md'), /Places you recommend [^.]*, each with the page that names it \(`uw add-point` reads it as `uw cite <page> --grep "<its name>"` would, when no `uw cite` did\)/);
  const help = (cmd) => uw([cmd, '--help']).then((r) => r.out.replace(/\s+/g, ' '));
  assert.match(await help('add-point'), /A source_url \(in --props\) that `uw cite` did not read in the last hours is read first, before any lookup, as uw cite reads a page \(robots\.txt, link-only sites, bot checks; kept for uw validate\)\. One that cannot be read \(HTTP 404, refused, no answer in time\) is refused \(exit 2, with why; nothing added\): give the place its own page instead\. So is an address that is not a page \(an image, a PDF\), and, once the place is found, a page that does not name it or a page another place already cites, where uw validate fails it: a trip's places to see, an area to stay in that says why \(exit 2, "cite its own page"; nothing added\)\. Elsewhere, or with under about 3 minutes left on the turn's clock, it is said and the place added\./);
  assert.match(await help('set'), /A new source_url that `uw cite` did not read in the last hours is read first, as uw cite reads a page \(robots\.txt, link-only sites, bot checks; kept for uw validate\)\. One that cannot be read \(HTTP 404, refused, no answer in time\) is refused \(exit 2, with why; nothing changed\): give the place its own page instead\. So is an address that is not a page \(an image, a PDF\), and a page that does not name the place or that another place already cites, where uw validate fails it: a trip's places to see, an area to stay in that says why \(exit 2, "cite its own page"\)\. Elsewhere, or with under about 3 minutes left on the turn's clock, it is said and taken\./);
  assert.match(await help('cite'), /a source_url it did not read they read themselves, the same way, and refuse one that cannot be read or is not a page/);
  // a place not found under its name is pinned by its OpenStreetMap object under the id or name it was looked up by
  assert.match(await help('add-point'), /until it is pinned under the id or name it was looked up by \(by its OpenStreetMap object: --osm <its osm id> --name "<that name>"\)/);
});
