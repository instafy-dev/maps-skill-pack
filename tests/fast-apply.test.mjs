// Long builds (2026-10-20): the Japan team case's builder hit the 10-minute turn limit in 3 of 4 runs; `uw handoff
// --apply` alone took about 5 minutes while each Overpass answer took ~37 s, and nothing said where the time went.
// These tests pin the generic fixes: stops are worked on side by side, the lodging around every stop is one batched
// Overpass request, identical lookups are answered from a cache every site shares, uw commands writing the same site
// at once never lose each other's writes, no command outlives the host's turn, every step's time is recorded, and a
// background job that a continuation turn can pick up runs outside the turn's clock.
// Offline: Photon / Overpass / OSRM are a local mock that answers every request after a delay.
// Run: node --test map-pack/tests/fast-apply.test.mjs
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
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', f)).href);
const { clockAdvice } = await lib('lib/turn-advice.mjs');
const { jobEnv, handOverTimings } = await lib('lib/jobs.mjs');
const { inPool, applyConcurrency, recordTimings } = await lib('lib/cmd-handoff.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-fast-'));
// this suite's Overpass slots and spacing (lock files in os.tmpdir()) are its own: other suites running at the same
// time never wait for its queries
fs.mkdirSync(path.join(tmp, 'os-tmp'));
const DELAY_MS = 300;

// ---------------------------------------------------------------------------
// a Japan of three stops
const CITIES = {
  Tokyo: { centre: [139.7594, 35.6828], station: [139.7671, 35.6812], local: '東京' },
  Kyoto: { centre: [135.7600, 34.9900], station: [135.7588, 34.9858], local: '京都' },
  Osaka: { centre: [135.5023, 34.6937], station: [135.4959, 34.7024], local: '大阪' },
};
const off = (c, dx, dy = 0) => [Math.round((c[0] + dx / 90000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const PLACES = {
  'Hotel Alpha Tokyo': off(CITIES.Tokyo.station, 300), 'Senso-ji': off(CITIES.Tokyo.station, 900, 400),
  'Hotel Beta Kyoto': off(CITIES.Kyoto.station, 250), 'Fushimi Inari': off(CITIES.Kyoto.station, 1500, -900),
  'Hotel Gamma Osaka': off(CITIES.Osaka.station, -200), 'Osaka Castle': off(CITIES.Osaka.station, 2500, -800),
};
const LODGING = Object.entries(CITIES).flatMap(([name, c], i) => [
  { id: 700 + i * 10, c: off(c.station, 120), name: `${name} Station Hotel` },
  { id: 701 + i * 10, c: off(c.station, -180, 60), name: `${name} Central Inn` },
  ...Object.entries(PLACES).filter(([n]) => n.startsWith('Hotel') && n.endsWith(name)).map(([n, coord], k) => ({ id: 702 + i * 10 + k, c: coord, name: n })),
]);
const feat = (name, coord, { key = 'place', value = 'city', id = 1, en } = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: coord },
  properties: { osm_type: 'N', osm_id: id, osm_key: key, osm_value: value, name: en || name, country: en ? 'Japan' : '日本', countrycode: 'JP' },
});
function photon(q, lang, tags) {
  const en = lang === 'en';
  const city = Object.keys(CITIES).find((c) => q === c || q === `${c}, Japan` || q === CITIES[c].local);
  if (city && tags.includes('place:city')) return [feat(CITIES[city].local, CITIES[city].centre, { id: 100 + Object.keys(CITIES).indexOf(city), en: en ? city : null })];
  if (city && tags.includes('railway:station')) return [feat(CITIES[city].local, CITIES[city].station, { key: 'railway', value: 'station', id: 200 + Object.keys(CITIES).indexOf(city), en: en ? city : null })];
  const name = Object.keys(PLACES).find((n) => q.split(',')[0].trim() === n);
  if (name && !tags.length) return [feat(name, PLACES[name], { key: name.startsWith('Hotel') ? 'tourism' : 'tourism', value: name.startsWith('Hotel') ? 'hotel' : 'attraction', id: 300 + Object.keys(PLACES).indexOf(name) })];
  return [];
}
function overpassAnswer(q) {
  const m = q.match(/around:(\d+(?:\.\d+)?),(-?[\d.]+),(-?[\d.]+)/);
  if (!/"tourism"~/.test(q) || !m) return [];
  const inRange = (c) => Math.hypot((c[0] - Number(m[3])) * 90000, (c[1] - Number(m[2])) * 111000) <= Number(m[1]) * 1.5;
  return LODGING.filter((e) => inRange(e.c)).map((e) => ({ type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: { tourism: 'hotel', name: e.name } }));
}
let mock;
function startMock() {
  const hits = { photon: [], overpass: [], osrm: 0 };
  const open = new Set();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      if (u.pathname.startsWith('/hang')) { open.add(res); return; }
      if (u.pathname.includes('/table/v1/')) {
        hits.osrm++;
        const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
        const d = pts.map((p) => Math.hypot((p[0] - pts[0][0]) * 90000, (p[1] - pts[0][1]) * 111000) * 1.2);
        res.end(JSON.stringify({ code: 'Ok', durations: [d.map((x) => x / 1.25)], distances: [d] }));
        return;
      }
      if (u.pathname === '/api/' || u.pathname === '/api') {
        hits.photon.push(u.searchParams.get('q'));
        res.end(JSON.stringify({ type: 'FeatureCollection', features: photon(u.searchParams.get('q'), u.searchParams.get('lang') || 'default', u.searchParams.getAll('osm_tag')) }));
        return;
      }
      if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
      if (u.pathname.includes('interpreter')) {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        hits.overpass.push(q);
        // a batch: each query's part, then its marker (what a real Overpass server does with `make uwbatch`)
        const parts = q.split(/make uwbatch i="(\d+)";\s*out;/);
        if (parts.length > 1 && hits.hangBatch) { open.add(res); return; }
        if (/"railway"/.test(q) && hits.hangRail) { open.add(res); return; }
        if (parts.length > 1) {
          const elements = [];
          for (let i = 0; i + 1 < parts.length; i += 2) elements.push(...overpassAnswer(parts[i]), { type: 'uwbatch', id: i / 2 + 1, tags: { i: parts[i + 1] } });
          res.end(JSON.stringify({ elements }));
        } else res.end(JSON.stringify({ elements: overpassAnswer(q) }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    }, DELAY_MS));
  });
  const close = () => { for (const r of open) { try { r.destroy(); } catch {} } server.closeAllConnections?.(); server.close(); };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, close, url: `http://127.0.0.1:${server.address().port}` })));
}
const env = (extra = {}) => {
  const e = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache-default'), UW_PHOTON: mock.url, UW_OVERPASS: mock.url + '/api/interpreter', UW_OSRM: mock.url, UW_VALHALLA: mock.url,
    UW_TURN_BUDGET: '0', INSTAFY_LOOKUP_STATE: path.join(tmp, 'lookup-health.json'), TMPDIR: path.join(tmp, 'os-tmp'), UW_RETRY_PAUSE_MS: '0', UW_APPLY_RAIL_TIMEOUT: '20', ...extra };
  for (const k of ['INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'UW_NO_CACHE', 'UW_JOB_TIMINGS']) if (!(k in extra)) delete e[k];
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
};
const uw = (args, extra = {}, cwd = tmp) => new Promise((resolve) => {
  const started = Date.now();
  const p = spawn(process.execPath, [UW, ...args], { cwd, env: env(extra) });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 240000);
  p.on('close', (code) => {
    clearTimeout(t);
    let json = null;
    if (args.includes('--json')) { try { json = JSON.parse(out); } catch { try { json = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)); } catch {} } }
    resolve({ code, out, err, json, ms: Date.now() - started });
  });
});
const readFC = (site, layer) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${layer}.geojson`), 'utf8'));

function writeHandoff(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const base = { schema: 'instafy.research@1', kind: 'city', country: 'Japan', facts: [], legs: [], unknowns: [] };
  for (const [city, hotel, sight] of [['Tokyo', 'Hotel Alpha Tokyo', 'Senso-ji'], ['Kyoto', 'Hotel Beta Kyoto', 'Fushimi Inari'], ['Osaka', 'Hotel Gamma Osaka', 'Osaka Castle']]) {
    fs.writeFileSync(path.join(dir, `${city.toLowerCase()}.json`), JSON.stringify({ ...base, item: city, places: [
      { name: hotel, query: `${hotel}, ${city}`, kind: 'hotel', why: 'close to the station', source_url: `https://example.org/${city}/hotel` },
      { name: sight, query: `${sight}, ${city}`, kind: 'sight', why: 'a classic', source_url: `https://example.org/${city}/sight` },
    ] }));
  }
}
const ROUTE = ['--route', 'Tokyo:3,Kyoto:3,Osaka:2', '--start', '2027-04-01', '--no-source-check'];
async function applyRun(site, extra) {
  await uw(['new', site, '--title', 'Japan by train', '--center', '137.0,35.2', '--zoom', '6'], extra);
  return uw(['handoff', path.join(tmp, 'handoff', 'japan'), '--site', site, '--apply', ...ROUTE, '--json'], extra);
}
const summary = (site) => ({
  stations: readFC(site, 'stations').features.map((f) => f.properties.id).sort(),
  stays: readFC(site, 'stays').features.map((f) => `${f.properties.stop}:${f.properties.name}:${f.properties.researched ? 'r' : ''}`).sort(),
  sights: readFC(site, 'sights').features.map((f) => f.properties.name).sort(),
  plan: JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8')).plan?.days?.length || 0,
});

before(async () => { mock = await startMock(); writeHandoff(path.join(tmp, 'handoff', 'japan')); });
after(() => { mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
test('handoff --apply works on the stops side by side: same map, much less time than one stop after another', async () => {
  const one = await applyRun('seq', { UW_APPLY_CONCURRENCY: '1', UW_CACHE: path.join(tmp, 'cache-seq') });
  assert.equal(one.code, 0, one.out.slice(-3000) + one.err);
  const three = await applyRun('par', { UW_APPLY_CONCURRENCY: '3', UW_CACHE: path.join(tmp, 'cache-par') });
  assert.equal(three.code, 0, three.out.slice(-3000) + three.err);
  assert.deepEqual(summary('par'), summary('seq'), 'the same stations, stays, sights and plan');
  assert.equal(summary('par').stations.length, 3);
  assert.ok(summary('par').stays.some((s) => /Hotel Beta Kyoto:r$/.test(s)), summary('par').stays.join('\n'));
  assert.equal(summary('par').sights.length, 3);
  assert.ok(summary('par').plan >= 8, 'the plan was written');
  // side by side: different stops' steps overlap in time; one after another: they never do
  const overlaps = (t) => {
    const steps = t.steps.filter((x) => /^(station|stays|sight) /.test(x.step));
    const stop = (x) => x.step.split(' ').pop();
    return steps.some((a) => steps.some((b) => stop(a) !== stop(b) && a.start_ms < b.start_ms + b.ms - 50 && b.start_ms < a.start_ms + a.ms - 50));
  };
  assert.equal(overlaps(one.json.timings), false, 'UW_APPLY_CONCURRENCY=1: one stop at a time');
  assert.equal(overlaps(three.json.timings), true, 'stops worked on side by side');
  // the stops' own work (stations, then stays, hotels and sights); the rail track loads in the background in both
  const stopWork = (t) => (t.phases.stations.to - t.phases.stations.from) + (Math.max(t.phases.stays.to, t.phases.places.to) - t.phases.stays.from);
  const tSeq = stopWork(one.json.timings), tPar = stopWork(three.json.timings);
  assert.ok(tPar < tSeq, `side by side ${tPar} ms vs one after another ${tSeq} ms`);
  assert.equal(three.json.timings.concurrency, 3);
  // the track never waits for the stops: it starts once the stations are placed
  const rail = three.json.timings.steps.find((x) => x.step === 'rail track');
  assert.ok(rail.start_ms < three.json.timings.phases.stays.from + 200, JSON.stringify(three.json.timings.phases));
});

test('the lodging around every stop is one batched Overpass request, and the stays are answered from it', async () => {
  mock.hits.overpass.length = 0;
  const r = await applyRun('batch', { UW_CACHE: path.join(tmp, 'cache-batch') });
  assert.equal(r.code, 0, r.out.slice(-3000) + r.err);
  const lodging = mock.hits.overpass.filter((q) => /"tourism"~/.test(q));
  assert.equal(lodging.length, 1, `lodging asked ${lodging.length} times:\n${lodging.join('\n---\n')}`);
  assert.equal((lodging[0].match(/make uwbatch/g) || []).length, 3, 'three stops in the one request');
  assert.match(r.out, /lodging around 3 stop\(s\) asked in one request: 3 answered/);
  assert.equal(readFC('batch', 'stays').features.filter((f) => f.properties.stop === 'osaka').length >= 1, true);
});

test('an identical lookup from another site is answered from the cache every site shares', async () => {
  const cache = path.join(tmp, 'cache-shared');
  await uw(['new', 'a1', '--title', 'A', '--center', '139.76,35.68', '--zoom', '12'], { UW_CACHE: cache });
  await uw(['new', 'a2', '--title', 'B', '--center', '139.76,35.68', '--zoom', '12'], { UW_CACHE: cache });
  const before = mock.hits.photon.length;
  const first = await uw(['add-point', 'a1', '--layer', 'sights', '--query', 'Senso-ji, Tokyo', '--near', CITIES.Tokyo.station.join(','), '--json'], { UW_CACHE: cache });
  assert.equal(first.code, 0, first.out + first.err);
  const asked = mock.hits.photon.length - before;
  assert.ok(asked >= 1);
  const second = await uw(['add-point', 'a2', '--layer', 'sights', '--query', 'Senso-ji, Tokyo', '--near', CITIES.Tokyo.station.join(','), '--json'], { UW_CACHE: cache });
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(mock.hits.photon.length - before, asked, 'the second site asked the place search nothing');
  assert.deepEqual(readFC('a2', 'sights').features[0].geometry.coordinates, readFC('a1', 'sights').features[0].geometry.coordinates);
  // UW_NO_CACHE still turns every cache off
  const third = await uw(['add-point', 'a2', '--layer', 'sights', '--query', 'Senso-ji, Tokyo', '--near', CITIES.Tokyo.station.join(','), '--id', 'again', '--json'], { UW_CACHE: cache, UW_NO_CACHE: '1' });
  assert.equal(third.code, 0);
  assert.ok(mock.hits.photon.length - before > asked, 'UW_NO_CACHE asks again');
});

test('a uw command waits for another one writing the same site instead of overwriting its changes', async () => {
  await uw(['new', 'lk', '--title', 'Lock', '--center', '139.76,35.68', '--zoom', '12']);
  const lock = path.join(tmp, 'lk', '.uwcache', 'write.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid)); // held by this (live) process
  const pending = uw(['add-point', 'lk', '--layer', 'sights', '--query', 'Senso-ji, Tokyo', '--near', CITIES.Tokyo.station.join(','), '--json']);
  await new Promise((r) => setTimeout(r, DELAY_MS * 6 + 1500));
  assert.equal(fs.existsSync(path.join(tmp, 'lk', 'data', 'sights.geojson')), false, 'nothing written while another writer holds the site');
  fs.unlinkSync(lock);
  const r = await pending;
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(readFC('lk', 'sights').features.length, 1);
  assert.equal(fs.existsSync(lock), false, 'the lock is released');
});

test('no network command outlives the host turn, whatever --timeout it was given', async () => {
  await uw(['new', 'hd', '--title', 'Host', '--center', '139.76,35.68', '--zoom', '12']);
  const now = Date.now();
  const r = await uw(['places', 'hd', '--layer', 'cafes', '--kinds', 'cafe', '--near', '139.76,35.68', '--radius', '500', '--timeout', '300'], {
    UW_OVERPASS: mock.url + '/hang/api/interpreter', UW_PHOTON: mock.url + '/hang', UW_TURN_BUDGET: undefined,
    INSTAFY_TURN_STARTED_AT: new Date(now - 550_000).toISOString(), INSTAFY_TURN_DEADLINE: new Date(now + 50_000).toISOString(),
  });
  assert.equal(r.code, 4, r.out + r.err);
  assert.ok(r.ms < 40_000, `ended after ${r.ms} ms, before the turn's hard limit`);
});

test('every step of --apply is timed: in the result, as one line, and in the step timings file', async () => {
  const file = path.join(tmp, 'timings', 'turn.ndjson');
  const extra = { UW_CACHE: path.join(tmp, 'cache-tm'), INSTAFY_STEP_TIMINGS_FILE: file };
  const r = await applyRun('tm', extra);
  assert.equal(r.code, 0, r.out.slice(-2000) + r.err);
  const t = r.json.timings;
  for (const phase of ['stations', 'rail', 'stays', 'places', 'plan']) assert.ok(t.phases[phase], `phase ${phase}: ${JSON.stringify(t.phases)}`);
  assert.ok(t.steps.some((s) => s.step === 'station Kyoto' && s.ms > 0 && s.exit === 0));
  assert.match(r.out, /\n\$ uw station \S+ --city Kyoto[^\n]*\n[\s\S]*?\n {2}\([\d.]+ s, exit 0\)/, 'each step prints as one block with its time');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.tool === 'uw' && l.command === 'handoff --apply' && l.step === 'stays Osaka'));
  assert.ok(lines.some((l) => l.step === 'total' && l.ms === t.total_ms));
  // the plain report says it in one line
  const plain = await uw(['handoff', path.join(tmp, 'handoff', 'japan'), '--site', 'tm', '--apply', ...ROUTE], extra);
  assert.equal(plain.code, 0, plain.out.slice(-2000));
  assert.match(plain.out, /\nTimings: [\d.]+ s in all, 3 stop\(s\) at a time; stations [\d.]+ s \(3\), rail [\d.]+ s \(2\)[^\n]*\. Slowest: [^\n]+\n/);
  // the card is out since `uw new`: the next step refreshes it, never posts another
  assert.match(plain.out, /then uw validate --signal and SKILL\.md step 9 \(refreshes the card\):\n/);
  assert.doesNotMatch(plain.out, /the preview card/);
});

test('a background job runs outside the turn clock when a continuation turn can pick it up, and hands its timings to the turn that sees it finish', async () => {
  const turn = { INSTAFY_TURN_STARTED_AT: '2026-10-20T10:00:00Z', INSTAFY_TURN_DEADLINE: '2026-10-20T10:10:00Z', INSTAFY_STEP_TIMINGS_FILE: '/t/turn1.ndjson' };
  const held = jobEnv({ ...turn, PATH: '/bin' }, '/j/job.ndjson');
  assert.equal(held.INSTAFY_TURN_DEADLINE, turn.INSTAFY_TURN_DEADLINE, 'no continuation: the job keeps the turn clock');
  assert.equal(held.UW_JOB_TIMINGS, '/j/job.ndjson');
  assert.equal(held.INSTAFY_STEP_TIMINGS_FILE, undefined);
  const free = jobEnv({ ...turn, INSTAFY_TURN_CONTINUE_FILE: '/t/continue.md' }, '/j/job.ndjson');
  assert.equal(free.INSTAFY_TURN_DEADLINE, undefined);
  assert.equal(free.INSTAFY_TURN_STARTED_AT, undefined);
  assert.equal(free.UW_TURN_BUDGET, '0');
  // the job's timings reach the turn that waits for it, once
  const dir = path.join(tmp, 'jobs-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handoff-1.timings.ndjson'), '{"step":"a","ms":5}\n');
  const turnFile = path.join(tmp, 'turn2.ndjson');
  assert.equal(handOverTimings(dir, 'handoff-1', { INSTAFY_STEP_TIMINGS_FILE: turnFile }), true);
  assert.equal(handOverTimings(dir, 'handoff-1', { INSTAFY_STEP_TIMINGS_FILE: turnFile }), false, 'not twice');
  assert.equal(fs.readFileSync(turnFile, 'utf8'), '{"step":"a","ms":5}\n');
  // end to end: a detached job's own step and uw wait's hand-over
  const cwd = fs.mkdtempSync(path.join(tmp, 'job-'));
  const waitFile = path.join(cwd, 'wait-turn.ndjson');
  const start = await uw(['geocode', 'Tokyo, Japan', '--detach'], { INSTAFY_TURN_CONTINUE_FILE: path.join(cwd, 'continue.md') }, cwd);
  const id = start.out.match(/started job (\S+):/)[1];
  let w;
  for (let i = 0; i < 30; i++) { w = await uw(['wait', id, '--max', '5'], { INSTAFY_STEP_TIMINGS_FILE: waitFile }, cwd); if (w.code !== 75) break; }
  assert.equal(w.code, 0, w.out + w.err);
  const got = fs.readFileSync(waitFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(got.some((l) => l.phase === 'job' && /uw geocode/.test(l.step) && l.exit === 0), JSON.stringify(got));
});

test('the turn clock says to hand off to a continuation turn only when the host offers one', () => {
  const gaps = { full: 6, empty: 2, thin: 0 };
  assert.match(clockAdvice(500, gaps, 480), /No time left for network steps: reply\./);
  assert.match(clockAdvice(500, gaps, 480, { continuation: true }), /INSTAFY_TURN_CONTINUE_FILE[\s\S]*a new turn continues from your saved files/);
  assert.match(clockAdvice(500, { full: 6, empty: 0, thin: 0 }, 480, { continuation: true }), /reply\./, 'nothing left to do: reply');
  assert.doesNotMatch(clockAdvice(100, gaps, 480, { continuation: true }), /CONTINUE/);
});

test('pool, concurrency and the timings file are plain helpers', async () => {
  let live = 0, peak = 0;
  const r = await inPool([1, 2, 3, 4, 5], 2, async (x) => { live++; peak = Math.max(peak, live); await new Promise((s) => setTimeout(s, 20)); live--; return x * 2; });
  assert.deepEqual(r, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
  assert.equal(applyConcurrency({}), 3);
  assert.equal(applyConcurrency({ UW_APPLY_CONCURRENCY: '1' }), 1);
  assert.equal(applyConcurrency({ UW_APPLY_CONCURRENCY: 'x' }), 1);
  assert.equal(recordTimings([{ step: 'a' }], {}), false, 'no file named: nothing written');
});

test('a batched request that a busy Overpass does not answer is cut short, and each stop asks for itself', async () => {
  mock.hits.hangBatch = true;
  try {
    const r = await applyRun('busy', { UW_CACHE: path.join(tmp, 'cache-busy'), UW_APPLY_BATCH_S: '2' });
    assert.equal(r.code, 0, r.out.slice(-2000) + r.err);
    const batch = r.json.timings.steps.find((s) => /^lodging lookup/.test(s.step));
    assert.ok(batch.ms < 6000, `the batch took ${batch.ms} ms`);
    assert.equal(batch.exit, 4);
    assert.ok(readFC('busy', 'stays').features.some((f) => f.properties.stop === 'kyoto'), 'stays still found by each stop');
  } finally { mock.hits.hangBatch = false; }
});

test('a rail track that failed after waiting is not asked again within --apply (0: never); a quick failure is', async () => {
  mock.hits.hangRail = true;
  try {
    const busy = { UW_APPLY_RAIL_TIMEOUT: '3', UW_APPLY_RAIL_RETRY_TIMEOUT: '3', UW_BASEMAP_TILES: mock.url + '/no-tiles.json' };
    const slow = await applyRun('rail-slow', { ...busy, UW_CACHE: path.join(tmp, 'cache-rail-1'), UW_APPLY_RAIL_RETRY_WITHIN_S: '0' });
    assert.equal(slow.code, 0, slow.out.slice(-2000) + slow.err);
    const steps = (r) => r.json.timings.steps.map((x) => x.step);
    assert.ok(steps(slow).includes('rail track'));
    assert.ok(!steps(slow).some((x) => /again/.test(x)), steps(slow).join(', '));
    assert.ok(slow.json.retry_rail?.length, 'the retry commands are in the report');
    const quick = await applyRun('rail-quick', { ...busy, UW_CACHE: path.join(tmp, 'cache-rail-2'), UW_APPLY_RAIL_RETRY_WITHIN_S: '60' });
    assert.equal(quick.code, 0, quick.out.slice(-2000) + quick.err);
    assert.ok(steps(quick).some((x) => /again/.test(x)), steps(quick).join(', '));
  } finally { mock.hits.hangRail = false; }
});
