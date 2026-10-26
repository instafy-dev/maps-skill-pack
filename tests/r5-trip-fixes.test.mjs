// Round-5 trip readback (Oct 19-20): the map's heading was the user's message cut at 70 characters ("…can you help
// plan"); researched alternatives were listed under it as "Not found yet"; reasons were cut mid-word ("…near the
// airp"); legs with no sourced time said only "check the timetable"; a base 6 km from Taitung station said nothing
// about it; and a Photon outage made `uw station` answer "no station named like Taichung" (exit 2, retry with a better
// query) instead of "service down" (exit 4, move on), so the agent retried and the swap never happened.
// Offline. Run: node --test map-pack/tests/r5-trip-fixes.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { clipWords } = await lib('util.mjs');
const { buildPlan, legEstimate } = await lib('cmd-plan.mjs');
const { noteMissing, forgetMissing } = await lib('cmd-geocode.mjs');
const { openSite } = await lib('site.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-r5-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A port nothing listens on: every connection is refused, like Photon's during the outage. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}
const uw = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_NO_CACHE: '1', UW_TURN_BUDGET: '0', ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 60000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
});

test('a reason is cut after a whole word, with an ellipsis', () => {
  assert.equal(clipWords('Short and sweet', 90), 'Short and sweet');
  const cut = clipWords('Two minutes from the station exit, quiet rooms on the river side, and a shuttle to the airport', 60);
  assert.ok(cut.length <= 60, cut);
  assert.match(cut, /…$/);
  assert.equal(cut, 'Two minutes from the station exit, quiet rooms on the…');
});

const stop = (id, name, coord) => ({ id, layer: 'stations', props: { id, name, name_en: name, station_of: name }, coord });

test('a base far from its station says how far and how; a near one stays quiet; reasons end on a word', () => {
  const taitung = stop('taitung', 'Taitung', [121.1238, 22.7937]); // Taitung station, about 6 km from the old centre
  const hualien = stop('hualien', 'Hualien', [121.6010, 23.9927]);
  const stays = [
    { _layer: 'stays', properties: { id: 'taitung-sheraton', name: 'Sheraton Taitung Hotel', stop: 'taitung', researched: true,
      why: 'Central Taitung hotel option close to the old railway art village and the night market, with river views' },
      geometry: { type: 'Point', coordinates: [121.1491, 22.7557] } },
    { _layer: 'stays', properties: { id: 'hualien-chantai', name: 'Chantai Hotel', stop: 'hualien', walk_min: 2 },
      geometry: { type: 'Point', coordinates: [121.6015, 23.9925] } },
  ];
  const plan = buildPlan({ stops: [hualien, taitung], nights: [1, 2], start: '2026-10-27', stays });
  const bases = plan.days.flatMap((d) => d.items).filter((it) => /^Base:/.test(it.text)).map((it) => it.text);
  assert.ok(bases.includes('Base: Chantai Hotel · 2 min walk to the station'), bases.join('\n'));
  const far = bases.find((t) => t.includes('Sheraton'));
  assert.match(far, /· (4\.\d|5(\.\d)?) km from the station: taxi or local bus ·/, far);
  assert.match(far, /…$/, 'the reason is clipped, not cut mid-word');
  const kept = far.split(' · ').pop().replace(/…$/, '');
  const why = stays[0].properties.why;
  assert.ok(why.startsWith(kept) && /^[^\p{L}\p{N}]/u.test(why.slice(kept.length)), `cut after a whole word: ${kept}`);
});

test('a leg with no sourced time gets a labelled estimate from its distance, never a bare "check the timetable"', () => {
  const est = legEstimate({ mode: 'train', distance_km: 150 });
  assert.equal(est, ' · about 2 h by train (estimate from 150 km; check the timetable)');
  assert.equal(legEstimate({ mode: 'hsr', distance_km: 300 }), ' · about 1.5 h by high-speed train (estimate from 300 km; check the timetable)');
  // no route length: the straight line between the stops, a little longer by rail
  const a = stop('a', 'A', [121.6010, 23.9927]), b = stop('b', 'B', [121.1238, 22.7937]);
  assert.match(legEstimate({}, a, b), /^ · about [\d.]+ h by train \(estimate from 1\d\d km; check the timetable\)$/);
  // nothing to go on: the old wording
  assert.equal(legEstimate({ mode: 'flight' }), ' · times: check the timetable');
  const plan = buildPlan({ stops: [a, b], nights: [1, 1], start: '2026-10-27' });
  const leg = plan.days.find((d) => d.title.includes('→')).items[0].text;
  assert.match(leg, /A → B · about [\d.]+ h by train \(estimate/);
});

test('uw new refuses an ask longer than the heading holds instead of cutting it', async () => {
  const long = "We're going to Taiwan for two weeks in late October, can you help plan the trip with hotels and trains?";
  const r = await uw(['new', 'long-ask', '--title', 'Taiwan by train', '--ask', long]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /write the question yourself in ≤ 70/);
  const ok = await uw(['new', 'short-ask', '--title', 'Taiwan by train', '--ask', 'Two weeks in Taiwan by train']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'short-ask', 'map.config.json'), 'utf8')).description, 'Two weeks in Taiwan by train');
});

/** A stand-in Overpass: Taichung's centre and its railway station, answered by name. */
async function mockOverpass() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
      const elements = [];
      if (/Taichung/i.test(q) && /"railway"="station"/.test(q)) elements.push({ type: 'node', id: 7001, lat: 24.13697, lon: 120.68512, tags: { railway: 'station', name: '臺中', 'name:en': 'Taichung' } });
      if (/Taichung/i.test(q) && /"place"(="city"|~)/.test(q)) elements.push({ type: 'relation', id: 7002, center: { lat: 24.1477, lon: 120.6736 }, tags: { place: 'city', name: '臺中市', 'name:en': 'Taichung' } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ elements }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/api/interpreter` };
}

test('a refused place lookup is an outage (exit 4), not "no station by that name" (exit 2)', async () => {
  assert.equal((await uw(['new', 'outage', '--title', 'Taiwan', '--center', '121.0,23.7', '--zoom', '7'])).code, 0);
  const photon = `http://127.0.0.1:${await closedPort()}`;
  const overpass = `http://127.0.0.1:${await closedPort()}/api/interpreter`;
  const wikipedia = `http://127.0.0.1:${await closedPort()}`;
  const r = await uw(['station', 'outage', '--city', 'Taichung', '--country', 'Taiwan', '--nights', '2'], { UW_PHOTON: photon, UW_OVERPASS: overpass, UW_WIKIPEDIA: wikipedia, UW_TIMEOUT: '20' });
  assert.equal(r.code, 4, `${r.out}\n${r.err}`);
  assert.doesNotMatch(`${r.out}\n${r.err}`, /No railway station named like/);
  // every uw command (a long `handoff --apply` too) now knows the lookup is down, for its cooldown (the shared health file)
  const { defaultStateFile } = await import('../skills/interactive-map/scripts/lib/lookup.mjs');
  const health = JSON.parse(fs.readFileSync(defaultStateFile(), 'utf8'));
  assert.ok(health.entries[`photon|${photon}`]?.open_until > Date.now(), JSON.stringify(health));
});

test('while Photon is down, a station is still found by name on OpenStreetMap through Overpass', async () => {
  assert.equal((await uw(['new', 'fallback', '--title', 'Taiwan', '--center', '121.0,23.7', '--zoom', '7'])).code, 0);
  const photon = `http://127.0.0.1:${await closedPort()}`;
  const mock = await mockOverpass();
  try {
    const r = await uw(['station', 'fallback', '--city', 'Taichung', '--country', 'Taiwan', '--nights', '2'], { UW_PHOTON: photon, UW_OVERPASS: mock.url, UW_WIKIPEDIA: `http://127.0.0.1:${await closedPort()}` });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const fc = JSON.parse(fs.readFileSync(path.join(tmp, 'fallback', 'data', 'stations.geojson'), 'utf8'));
    const st = fc.features.find((f) => /taichung/i.test(f.properties.id));
    assert.ok(st, JSON.stringify(fc.features.map((f) => f.properties.id)));
    assert.deepEqual(st.geometry.coordinates, [120.68512, 24.13697]);
  } finally { mock.server.close(); }
});

test('while Photon is down, a city and its main station come from Wikipedia\'s article coordinates first', async () => {
  const pages = {
    Taichung: { pageid: 1, title: 'Taichung', coordinates: [{ lat: 24.1477, lon: 120.6736 }] },
    'Taichung railway station': { pageid: 2, title: 'Taichung railway station', coordinates: [{ lat: 24.137, lon: 120.6868 }] },
  };
  const server = http.createServer((req, res) => {
    const titles = new URL(req.url, 'http://x').searchParams.get('titles').split('|');
    const found = Object.fromEntries(titles.filter((t) => pages[t]).map((t) => [pages[t].pageid, pages[t]]));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ query: { pages: Object.keys(found).length ? found : { '-1': { missing: '' } } } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await uw(['new', 'wiki', '--title', 'Taiwan', '--zoom', '5'])).code, 0, 'no centre: the site starts on the default view');
    const r = await uw(['station', 'wiki', '--city', 'Taichung', '--country', 'Taiwan', '--nights', '2'], {
      UW_PHOTON: `http://127.0.0.1:${await closedPort()}`, UW_OVERPASS: `http://127.0.0.1:${await closedPort()}/api/interpreter`,
      UW_WIKIPEDIA: `http://127.0.0.1:${server.address().port}` });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const fc = JSON.parse(fs.readFileSync(path.join(tmp, 'wiki', 'data', 'stations.geojson'), 'utf8'));
    assert.deepEqual(fc.features[0].geometry.coordinates, [120.6868, 24.137]);
  } finally { server.close(); }
});

test('a researched alternative that was not found leaves the "Not found yet" list', async () => {
  assert.equal((await uw(['new', 'missing', '--title', 'Trip', '--center', '121.5,25.0', '--zoom', '7'])).code, 0);
  const site = openSite(path.join(tmp, 'missing'));
  noteMissing(site, { layer: 'stays', id: 'kaohsiung-kindness-hotel', name: 'Kindness Hotel', query: 'Kindness Hotel, Kaohsiung' });
  noteMissing(site, { layer: 'sights', id: 'anping-fort', name: 'Anping Fort' });
  assert.equal(JSON.parse(fs.readFileSync(site.cfgPath, 'utf8')).missing.length, 2);
  assert.equal(forgetMissing(site, { layer: 'stays', id: 'kaohsiung-kindness-hotel', name: 'Kindness Hotel' }), true);
  const left = JSON.parse(fs.readFileSync(site.cfgPath, 'utf8')).missing;
  assert.deepEqual(left.map((m) => m.name), ['Anping Fort'], 'a real gap (a sight) stays listed');
  assert.equal(forgetMissing(site, { layer: 'stays', id: 'nothing', name: 'Nothing' }), false);
});
