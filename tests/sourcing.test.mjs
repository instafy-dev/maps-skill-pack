// Sourcing helpers (reference/itinerary.md, research-team workers): `uw cite` fetches one page as a fact source and
// refuses link-only sites, robots.txt-blocked paths and bot checks; `uw transit` turns a MOTIS journey-planner answer
// into a ride time with a source, and is skipped when no planner is configured (Transitous is non-commercial only).
// Offline: a local mock server stands in for the web and the planner.
// Run: node --test map-pack/tests/sourcing.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { linkOnly, parseRobots, robotsBlocker, challengeReason, pageText, politeFetch } = await lib('cmd-cite.mjs');
const { summarisePlan, searchStartIso } = await lib('cmd-transit.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-src-'));
let server, base;
const PLAN = {
  itineraries: [
    { legs: [{ mode: 'WALK', startTime: '2026-10-23T00:39:00Z', endTime: '2026-10-23T00:43:00Z' },
      { mode: 'REGIONAL_RAIL', from: { name: '臺北', tz: 'Asia/Taipei' }, to: { name: '花蓮', tz: 'Asia/Taipei' }, startTime: '2026-10-23T00:43:00Z', endTime: '2026-10-23T03:07:00Z', agencyName: 'TRA', displayName: '自強' },
      { mode: 'WALK', startTime: '2026-10-23T03:07:00Z', endTime: '2026-10-23T03:11:00Z' }] },
    { legs: [{ mode: 'REGIONAL_RAIL', from: { name: '臺北', tz: 'Asia/Taipei' }, to: { name: '宜蘭', tz: 'Asia/Taipei' }, startTime: '2026-10-23T01:00:00Z', endTime: '2026-10-23T02:10:00Z', agencyName: 'TRA' },
      { mode: 'REGIONAL_RAIL', from: { name: '宜蘭', tz: 'Asia/Taipei' }, to: { name: '花蓮', tz: 'Asia/Taipei' }, startTime: '2026-10-23T02:30:00Z', endTime: '2026-10-23T03:50:00Z', agencyName: 'TRA' }] },
    { legs: [{ mode: 'WALK', startTime: '2026-10-23T05:00:00Z', endTime: '2026-10-23T05:10:00Z' }] },
  ],
};
let planQuery = null;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (u.pathname === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /guide/no-ai\n', 'text/plain');
    if (u.pathname === '/guide/hualien') return send(200, '<html><head><title>Hualien guide</title><script>ignore()</script></head><body><h1>Hualien</h1><p>Taroko Express takes about 2 h &amp; 10 min.</p><p>Night market opens at 17:00.</p></body></html>');
    if (u.pathname === '/challenge') return send(200, '<html><title>Just a moment...</title><div class="cf-challenge"></div></html>');
    if (u.pathname === '/denied') return send(403, 'Forbidden');
    if (u.pathname === '/hop-private') { res.writeHead(302, { location: '/private/page' }); return res.end(); }
    if (u.pathname === '/hop-ok') { res.writeHead(301, { location: '/guide/hualien' }); return res.end(); }
    if (u.pathname === '/private/page') return send(200, '<p>private</p>');
    if (u.pathname === '/api/v5/plan') { planQuery = Object.fromEntries(u.searchParams); return send(200, JSON.stringify(PLAN), 'application/json'); }
    return send(404, 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function uw(args, env = {}) {
  return new Promise((resolve) => {
    // the mock web is on 127.0.0.1, which cite refuses unless UW_ALLOW_LOCAL=1
    const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_CACHE_DIR: path.join(tmp, 'cache'), UW_TRANSIT_URL: '', UW_ALLOW_LOCAL: '1', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('link-only sites are refused by host, including their country domains', () => {
  for (const u of ['https://www.booking.com/hotel/tw/x.html', 'https://www.agoda.com/x', 'https://www.airbnb.com.tw/rooms/1', 'https://www.amazon.co.uk/dp/1',
    'https://www.nike.com/t/x', 'https://www.expedia.com/h', 'https://www.hotels.com/x', 'https://www.trip.com/hotels', 'https://www.tripadvisor.com/x',
    'https://www.google.com/search?q=x', 'https://www.google.com.tw/travel/hotels', 'https://runrepeat.com/x']) assert.ok(linkOnly(u), u);
  for (const u of ['https://www.railway.gov.tw/', 'https://en.wikivoyage.org/wiki/Hualien', 'https://www.thsrc.com.tw/', 'https://notbooking.com.example.org/'])
    assert.equal(linkOnly(u), null, u);
});

test('robots.txt blocks a path disallowed for all bots or for one AI agent; Allow wins a longer match', () => {
  const g = parseRobots('User-agent: *\nDisallow: /search\nAllow: /search/about\n\nUser-agent: ClaudeBot\nUser-agent: GPTBot\nDisallow: /reviews/\n# comment\nUser-agent: Bingbot\nDisallow: /\n');
  assert.equal(robotsBlocker(g, '/search?q=hotel'), '*');
  assert.equal(robotsBlocker(g, '/search/about'), null);
  assert.equal(robotsBlocker(g, '/reviews/123'), 'gptbot');
  assert.equal(robotsBlocker(g, '/guide/'), null, 'Bingbot rules do not apply to us');
  assert.equal(robotsBlocker(parseRobots('User-agent: *\nDisallow: /*.pdf$\n'), '/a/b.pdf'), '*');
  assert.equal(robotsBlocker(parseRobots(''), '/anything'), null);
});

test('bot checks and login walls are recognised; page text drops scripts and keeps blocks', () => {
  assert.match(challengeReason(403, ''), /blocked/);
  assert.match(challengeReason(429, ''), /blocked/);
  assert.match(challengeReason(401, ''), /login/);
  assert.match(challengeReason(200, '<div class="g-recaptcha"></div>'), /CAPTCHA/);
  assert.equal(challengeReason(200, '<p>Welcome</p>'), null);
  const t = pageText('<title>A &amp; B</title><script>evil()</script><p>One</p><p>Two&nbsp;three</p>');
  assert.equal(t.title, 'A & B');
  assert.deepEqual(t.lines.slice(-2), ['One', 'Two three']);
  assert.ok(!t.lines.join(' ').includes('evil'));
});

test('uw cite prints the source and matching lines, and refuses robots-blocked and challenge pages', async () => {
  const ok = await uw(['cite', `${base}/guide/hualien`, '--grep', 'taroko', '--json']);
  assert.equal(ok.code, 0, ok.err);
  const j = JSON.parse(ok.out);
  assert.equal(j.url, `${base}/guide/hualien`);
  assert.equal(j.title, 'Hualien guide');
  assert.match(j.retrieved_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(j.excerpt, 'Taroko Express takes about 2 h & 10 min.');
  for (const p of ['/private/x', '/guide/no-ai', '/challenge', '/denied']) {
    const r = await uw(['cite', `${base}${p}`]);
    assert.equal(r.code, 2, `${p}: ${r.out}${r.err}`);
    assert.match(r.out, /refused: .*\n.*plain link/, p);
  }
  const lo = await uw(['cite', 'https://www.agoda.com/hotel/1']);
  assert.equal(lo.code, 2);
  assert.match(lo.out, /link-only site: Agoda/);
});

test('transit: ride time from the first boarding to the last alighting, median of the options', () => {
  const s = summarisePlan(PLAN, { count: 3 });
  assert.equal(s.options.length, 2, 'a walk-only option is dropped');
  assert.deepEqual(s.options.map((o) => o.duration_min), [144, 170]);
  assert.equal(s.options[1].transfers, 1);
  assert.equal(s.duration_min, 144);
  assert.deepEqual(s.operators, ['TRA']);
  assert.match(s.options[0].depart_local, /08:43/, 'local station time');
});

test('uw transit is skipped without a planner and sources the duration with one', async () => {
  const none = await uw(['transit', '--from', '121.517,25.0478', '--to', '121.6014,23.9931', '--date', '2026-10-23']);
  assert.equal(none.code, 4, none.err);
  assert.match(none.err, /no journey planner is configured/);
  const r = await uw(['transit', '--from', '121.517,25.0478', '--to', '121.6014,23.9931', '--date', '2026-10-23', '--json'], { UW_TRANSIT_URL: base });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.duration_min, 144);
  assert.match(j.source_url, /\/api\/v5\/plan\?fromPlace=25\.0478%2C121\.517/);
  assert.match(j.source, /TRA timetable via 127\.0\.0\.1/);
  assert.equal(planQuery.transitModes, 'RAIL');
  assert.equal(planQuery.time, '2026-10-23T00:00:00Z');
});

test('cite checks every redirect hop against robots.txt; a refusal ends that URL, not the research', async () => {
  const blocked = await uw(['cite', `${base}/hop-private`, '--json']);
  assert.equal(blocked.code, 2, blocked.out + blocked.err);
  const j = JSON.parse(blocked.out);
  assert.match(j.refused, /redirected to .*\/private\/page: robots\.txt disallows \/private\/page for all bots/);
  const ok = await uw(['cite', `${base}/hop-ok`, '--grep', 'Taroko', '--json']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).url, `${base}/guide/hualien`);
  const denied = await uw(['cite', `${base}/denied`]);
  assert.equal(denied.code, 2);
  const text = denied.out + denied.err;
  assert.match(text, /This URL only/);
  assert.match(text, /try|keep researching from a different source/);
  assert.doesNotMatch(text, /stop here/);
});

test('transit searches the origin\'s morning, not 00:00 UTC (the evening before in the Americas)', () => {
  assert.equal(searchStartIso('2026-10-23', 121.5), '2026-10-23T00:00:00Z', 'Taipei: 08:00 local');
  assert.equal(searchStartIso('2026-10-23', -74.0), '2026-10-23T13:00:00Z', 'New York: 08:00 solar time');
  assert.equal(searchStartIso('2026-10-23', -9.14), '2026-10-23T09:00:00Z', 'Lisbon');
  assert.equal(searchStartIso('2026-10-23', 139.7), '2026-10-22T23:00:00Z', 'Tokyo: 08:00 local is the UTC day before');
});

test('cite never reads a private, loopback or metadata address, also through a redirect', async () => {
  const local = await uw(['cite', `${base}/guide/hualien`, '--json'], { UW_ALLOW_LOCAL: '' });
  assert.equal(local.code, 2, local.out + local.err);
  assert.match(JSON.parse(local.out).refused, /127\.0\.0\.1 is a private or local address/);
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]:43127/', 'http://10.0.0.5/x', 'http://host.docker.internal:8788/']) {
    const r = await politeFetch(url);
    assert.ok(r.refused && /private|local/.test(r.refused), `${url}: ${JSON.stringify(r)}`);
  }
});

test('robots.txt rules match percent-encoded and doubled-slash spellings of a path', () => {
  const g = parseRobots('User-agent: *\nDisallow: /private\n');
  for (const p of ['/private/a', '/%70rivate/a', '//private/a', '/%70RIVATE'.toLowerCase()]) assert.equal(robotsBlocker(g, p), '*', p);
  assert.equal(robotsBlocker(g, '/%2570rivate'), null, 'an escaped % is not a p');
  assert.equal(robotsBlocker(g, '/public'), null);
  assert.ok(linkOnly('https://a.co/d/abc'), 'Amazon short links are link-only');
});

// The 1 Nov 2026 Seville map cited Wikipedia for every sight, the cathedral included, whose own site the 31 Oct run
// had cited. The trip guide puts the venue's own site first, as the web-research skill's sources by need do, and says
// how to find it; its Wikipedia article is the fallback.
test('the trip guide sources a sight from the venue\'s own site first; its Wikipedia article only when it has none that can be read', () => {
  const md = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8').replace(/\s+/g, ' ');
  const step1 = md.slice(md.indexOf('1. **Sights with sources'), md.indexOf('2. **Train times**'));
  assert.match(step1, /The venue's own site first, as skill `instafy-web-research` ranks sources \(its "Sources by need"\): the attraction's, park's or operator's official site, one you know or the one `instafy web search "<its name>" --chain reference-search --json` lists; its Wikipedia article only when the venue has no site that names it and can be read\./);
  assert.doesNotMatch(step1, /else its Wikipedia article/);
});
