// "Plan 3 days in Seville for a first visit: where to stay, what to see each day, on a map" (a run on 6 Nov 2026). The
// turn read the trip reference with its output capped at 4,000 tokens: the host keeps the first and the last 2,000
// (about 8,000 bytes each) and cuts the middle, and the middle held "One base" and Phase B. It followed the steps it
// saw, "Stays by the station", and put the stays by the railway station outside the old town; it gave two of its three
// days one place each and replied, with time left; and it cited Wikipedia for every sight. Its `uw plan --json` printed
// the route but not the line for the reply, so the reply named neither the dates nor that they were assumed (an
// earlier run that day, the same).
// Now a one-place trip's part of the reference comes first, the reply line is in the JSON too, a stay's reason leaves
// out the kind its card already shows ("· hotel"), and `uw cite` of an article prints the subject's own site.
// Offline: a local server stands in for the article's site.
// Run: node --test tests/one-base-first.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { ownSiteLink } = await lib('cmd-cite.mjs');
const { rankStays } = await lib('cmd-stay.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-one-base-first-'));
let server, base;
// an encyclopedia article as the web serves it: the infobox's "Website" row (its label a link) and the "Official
// website" link under External links; a second article links only a sister project
const ARTICLE = '<html><head><title>Alcázar of Seville - Wikipedia</title></head><body><h1>Alcázar of Seville</h1>'
  + '<table class="infobox"><tr><th scope="row" class="infobox-label"><a href="/wiki/Website" title="Website">Website</a></th>'
  + '<td class="infobox-data"><span class="url"><a rel="nofollow" class="external text" href="https://www.alcazarsevilla.org">alcazarsevilla.org</a></span></td></tr></table>'
  + '<p>The Royal Alcázar of Seville is a royal palace in Seville.</p>'
  + '<h2>External links</h2><ul><li><span class="official-website"><span class="url"><a rel="nofollow" class="external text" href="https://www.alcazarsevilla.org/">Official website</a></span></span></li>'
  + '<li><a href="https://commons.wikimedia.org/wiki/Category:Alc%C3%A1zar_of_Seville">Media</a></li></ul></body></html>';
const NO_SITE = '<html><head><title>Torre del Oro - Wikipedia</title></head><body><p>The Torre del Oro is a watchtower in Seville.</p>'
  + '<h2>External links</h2><ul><li><a href="https://commons.wikimedia.org/wiki/Category:Torre_del_Oro">Media</a></li></ul></body></html>';

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (u.pathname === '/wiki/Alcazar_of_Seville') return send(200, ARTICLE);
    if (u.pathname === '/wiki/Torre_del_Oro') return send(200, NO_SITE);
    return send(404, 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function uw(args, env = {}) {
  return new Promise((resolve) => {
    // the stand-in site is on 127.0.0.1, which cite refuses unless UW_ALLOW_LOCAL=1; what it reads stays in tmp
    const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_NO_CACHE: '1', UW_ALLOW_LOCAL: '1', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
  });
}
const point = (id, coord, props = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { id, ...props } });

// ---------------------------------------------------------------------------
test('the trip reference: a one-place trip reads "One base" and Phase B before the steps for several stops, in its first 4,000 tokens and in a read capped at 4,000', () => {
  const bytes = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'));
  const md = bytes.toString('utf8');
  const flat = (s) => s.replace(/\s+/g, ' ');
  const oneBase = md.slice(md.indexOf('## One base'), md.indexOf('## Phase B'));
  const phaseB = md.slice(md.indexOf('## Phase B'), md.indexOf('2. **Train times**'));
  const reply = md.slice(md.indexOf('## Reply'));
  assert.ok(oneBase.length > 2000 && phaseB.length > 2000 && reply.length > 1500, 'the sections are found');
  // "One base" right after step 1, then Phase B, then the steps a trip of several stops takes instead
  assert.ok(md.indexOf('**1. Site.**') < md.indexOf('## One base'));
  assert.ok(md.indexOf('## Phase B') < md.indexOf('**2. One station per stop**'));
  assert.ok(md.indexOf('**2. One station per stop**') < md.indexOf('**3. Stays by the station**'));
  assert.match(flat(oneBase), /Step 0 \(parse, defaults, the `Assumed:` line\), step 1, Phase B \(next\) and step 6 \(`uw validate <site> --signal`, then SKILL\.md step 9\) stay; instead of steps 2-5, which are for several stops:/);
  assert.match(flat(md), /## Several stops: stations, stays, trains \(Phase A, steps 2-6\) Two or more places with nights \(one place: "One base" above\)\. Phase B follows step 6\./);
  // its first 4,000 tokens (4 bytes a token, as the host counts them) hold all a one-place trip reads
  const first = bytes.subarray(0, 4000 * 4).toString('utf8');
  for (const part of [oneBase, phaseB]) assert.ok(first.includes(part), part.slice(0, 60));
  // a read capped at 4,000 tokens keeps "One base" whole, Phase B's rule to add places rather than reply, the own
  // site before Wikipedia, and the whole reply
  const capped = bytes.subarray(0, 8000).toString('utf8') + '\n…\n' + bytes.subarray(bytes.length - 8000).toString('utf8');
  assert.ok(capped.includes(oneBase), 'One base whole');
  assert.ok(capped.includes(reply), 'the reply whole');
  assert.match(flat(capped), /While any is and time is left, add sights rather than reply\./);
  assert.match(flat(capped), /Each place's source is the venue's own site, the one you cite: `uw cite <its own site> --grep "<its name>"`\./);
  assert.match(flat(capped), /Its Wikipedia article only where the turn found no such site that names it and can be read\./);
  // the reply: the stay with its dates and the Assumed: line, also for one place; a day with one place only when the
  // time ran out
  assert.match(flat(oneBase), /The reply \("Reply", at the end\): the stay with its dates as `uw plan` prints it, the `Assumed:` line \(the dates too, when the person gave none\), where to stay and why, then each day's area\./);
  assert.match(flat(reply), /as `uw plan` prints it \("Route for the reply"; one stop: "Stay for the reply"\)/);
  assert.match(flat(reply), /2\. The `Assumed:` line from step 0: only what you filled in, the dates too when the person gave none\./);
  assert.match(flat(reply), /a full day still with one place to see when the time ran out \(`uw validate` names it then\)/);
});

test('uw plan --json carries the stay or route for the reply with its dates and the "Assumed:" line, as the plain output prints it', async () => {
  const site = 'seville';
  assert.equal((await uw(['new', site, '--title', 'First visit to Seville', '--center', '-5.99534,37.38863', '--zoom', '13', '--expect', 'Seville:3'])).code, 0);
  const dir = path.join(tmp, site);
  const write = (layer, feats) => fs.writeFileSync(path.join(dir, 'data', `${layer}.geojson`), JSON.stringify({ type: 'FeatureCollection', features: feats }));
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  write('stops', [point('seville', [-5.99534, 37.38863], { name: 'Seville', kind: 'city', nights: 3 })]);
  cfg.layers = [{ id: 'stops', type: 'points', title: 'Stops', data: 'data/stops.geojson' }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const line = 'Stay for the reply, with its dates: Seville 3 (3 nights, Sat 7 Nov – Tue 10 Nov). The dates and nights are assumptions unless the person gave them: '
    + 'say those in the reply\'s "Assumed:" line ("Assumed: arrive Sat 7 Nov, 3 nights").';
  const j = await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-07', '--json']);
  assert.equal(j.code, 0, j.out + j.err);
  assert.equal(j.json.route, 'Seville 3 (3 nights, Sat 7 Nov – Tue 10 Nov)');
  assert.equal(j.json.for_the_reply, line);
  // right after the route, before the long plan: a read cut in its middle keeps it
  const keys = Object.keys(j.json);
  assert.equal(keys.indexOf('for_the_reply'), keys.indexOf('route') + 1);
  const plain = await uw(['plan', site, '--stops', 'stops', '--ids', 'seville', '--nights', '3', '--start', '2026-11-07', '--force']);
  assert.equal(plain.code, 0, plain.out + plain.err);
  assert.ok(plain.out.split('\n').includes(line), plain.out);

  // several stops: the route and its night split
  const trip = 'porto-lisbon';
  assert.equal((await uw(['new', trip, '--title', 'Porto and Lisbon', '--center', '-8.8,40', '--zoom', '7', '--expect', 'Porto:3,Lisbon:4'])).code, 0);
  const tdir = path.join(tmp, trip);
  fs.writeFileSync(path.join(tdir, 'data', 'stops.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
    point('porto', [-8.6110, 41.1496], { name: 'Porto', kind: 'city', nights: 3 }), point('lisbon', [-9.1393, 38.7223], { name: 'Lisbon', kind: 'city', nights: 4 })] }));
  const tcfgPath = path.join(tdir, 'map.config.json');
  const tcfg = JSON.parse(fs.readFileSync(tcfgPath, 'utf8'));
  tcfg.layers = [{ id: 'stops', type: 'points', title: 'Stops', data: 'data/stops.geojson' }];
  fs.writeFileSync(tcfgPath, JSON.stringify(tcfg, null, 2));
  const t = await uw(['plan', trip, '--stops', 'stops', '--ids', 'porto,lisbon', '--nights', '3,4', '--start', '2026-11-07', '--json']);
  assert.equal(t.code, 0, t.out + t.err);
  assert.equal(t.json.for_the_reply, `Route for the reply, with its dates: ${t.json.route}. The dates and the night split are assumptions unless the person gave them: `
    + 'say those in the reply\'s "Assumed:" line ("Assumed: arrive Sat 7 Nov, 7 nights").');
  assert.match(t.json.route, /^Porto 3 → Lisbon 4 \(7 nights, Sat 7 Nov – Sat 14 Nov\)$/);
});

test('a stay\'s reason leaves out the kind its card and the Places list already name ("· hotel"), and keeps what they do not', () => {
  const c = (o) => ({ name: 'N', coord: [0, 0], walk_min: 5, walk_m: 384, walk_basis: 'routed', registered: false, group: 'hotel', ...o });
  const why = (o) => rankStays([c(o)], { to: 'Sevilla - Santa Justa' })[0].why;
  assert.equal(why({ osm_kind: 'hotel' }), '5 min walk to Sevilla - Santa Justa');
  assert.equal(why({ osm_kind: 'hotel', stars: '4' }), '5 min walk to Sevilla - Santa Justa · 4★');
  assert.equal(why({ osm_kind: 'hostel', group: 'hostel' }), '5 min walk to Sevilla - Santa Justa');
  assert.equal(why({ osm_kind: 'guest_house', group: 'bnb' }), '5 min walk to Sevilla - Santa Justa');
  // a word the card's kind does not say stays: a motel's card reads "Hotel", an apartment's "Guest house"
  assert.equal(why({ osm_kind: 'motel' }), '5 min walk to Sevilla - Santa Justa · motel');
  assert.equal(why({ osm_kind: 'apartment', group: 'bnb' }), '5 min walk to Sevilla - Santa Justa · apartment');
  // an estimated walk and a register's listing as before
  assert.equal(why({ osm_kind: 'hotel', walk_basis: 'est.' }), 'about 5 min walk to Sevilla - Santa Justa');
  assert.equal(why({ registered: true, cls: 'hotel', rooms: 40 }), '5 min walk to Sevilla - Santa Justa · registered hotel, 40 rooms');
});

test('uw cite of an article that links its subject\'s own site prints that address: for a place, its own site comes first', async () => {
  assert.equal(ownSiteLink(ARTICLE, 'https://en.wikipedia.org/wiki/Alc%C3%A1zar_of_Seville'), 'https://www.alcazarsevilla.org/');
  // the infobox's row alone, its label a link; an entity in the address; a link to the wiki's own projects is none
  const row = ARTICLE.slice(ARTICLE.indexOf('<table'), ARTICLE.indexOf('</table>') + 8).replace('https://www.alcazarsevilla.org', 'https://example.org/visit?a=1&amp;b=2');
  assert.equal(ownSiteLink(row, 'https://en.wikipedia.org/wiki/X'), 'https://example.org/visit?a=1&b=2');
  assert.equal(ownSiteLink(NO_SITE, 'https://en.wikipedia.org/wiki/Torre_del_Oro'), null);
  assert.equal(ownSiteLink('<th>Website</th><td><a href="https://www.wikidata.org/wiki/Q1#P856">edit</a></td>', 'https://en.wikipedia.org/wiki/X'), null);
  assert.equal(ownSiteLink('<th>Website</th><td><a href="javascript:alert(1)">x</a></td>', 'https://en.wikipedia.org/wiki/X'), null);
  // the address is the page's own text: a long one is no address to print
  assert.equal(ownSiteLink(`<th>Website</th><td><a href="https://example.org/${'a'.repeat(200)}">x</a></td>`, 'https://en.wikipedia.org/wiki/X'), null);

  const r = await uw(['cite', `${base}/wiki/Alcazar_of_Seville`, '--grep', 'Alcázar', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.own_site, 'https://www.alcazarsevilla.org/');
  assert.equal(r.json.next, 'For a place, its own site is its source before this page: uw cite https://www.alcazarsevilla.org/ --grep "<its name>"; '
    + 'this page only when that one cannot be read or does not name the place.');
  // before the page's lines: a read cut in its middle keeps it
  const keys = Object.keys(r.json);
  assert.ok(keys.indexOf('own_site') < keys.indexOf('excerpt'), keys.join(','));
  const plain = await uw(['cite', `${base}/wiki/Alcazar_of_Seville`, '--grep', 'Alcázar']);
  assert.equal(plain.code, 0, plain.out + plain.err);
  assert.match(plain.out, /^own site: https:\/\/www\.alcazarsevilla\.org\/\. For a place, its own site is its source before this page: uw cite https:\/\/www\.alcazarsevilla\.org\/ --grep "<its name>"; this page only when that one cannot be read or does not name the place\.$/m);
  // an article that links no site of its subject's own says nothing of one
  const none = await uw(['cite', `${base}/wiki/Torre_del_Oro`, '--grep', 'Torre del Oro', '--json']);
  assert.equal(none.code, 0, none.out + none.err);
  assert.equal(none.json.own_site, undefined);
  assert.equal(none.json.next, undefined);
});
