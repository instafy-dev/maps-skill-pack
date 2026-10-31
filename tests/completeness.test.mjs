// Completeness (r11): in every r10 Taiwan team run the map left out Hualien and Taitung although the traveller asked
// for them and research lanes covered them. The place search was unavailable, Wikipedia's plain titles "Hualien" and
// "Taitung" are disambiguation pages, Overpass was slow, so `uw handoff --apply` placed neither the station nor the
// city, dropped both stops from the route and the plan (10 of 14 nights), and `uw validate` still passed.
// These tests pin the generic fixes:
// - a city whose plain Wikipedia title is a disambiguation page is found under "<Name> City" / "<Name>, <Country>"
//   near the map (never far away);
// - the request's items are kept as the map's "expect" and `uw validate` fails while one is not on the map or in no
//   day of the plan (`--expect` checks a list the config does not carry);
// - `uw handoff --apply` writes the route as "expect" before any lookup, tries a stop it could not place once more
//   after the stays, and says loudly (first and last, exit 3) which requested stops the map still leaves out.
// Offline: Photon, Wikipedia, Overpass and OSRM are a local mock.
// Run: node --test map-pack/tests/completeness.test.mjs
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
const { parseExpect, uncovered, featureNames, textNames, mergeExpect } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'expect.mjs')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-complete-'));
fs.mkdirSync(path.join(tmp, 'os-tmp'));

// ---------------------------------------------------------------------------
// a three-stop trip in a made-up country: Alpha (found at once), Beta (its plain Wikipedia title is ambiguous; in the
// --apply runs a busy Overpass answers its name only once the services have had a few minutes, i.e. after the first
// lodging request) and Gamma (never found). As in r10, the place search (Photon) is down in the --apply runs.
const CITIES = {
  Alpha: { centre: [10.00, 50.00], station: [10.004, 50.002] },
  Beta: { centre: [11.00, 50.50], station: [11.003, 50.503] },
  Gamma: { centre: [12.00, 51.00], station: [12.002, 51.001] },
};
const off = (c, dx, dy = 0) => [Math.round((c[0] + dx / 70000) * 1e6) / 1e6, Math.round((c[1] + dy / 111000) * 1e6) / 1e6];
const LODGING = Object.entries(CITIES).flatMap(([name, c], i) => [
  { id: 900 + i * 10, c: off(c.station, 120), name: `${name} Station Hotel` },
  { id: 901 + i * 10, c: off(c.station, -150, 60), name: `${name} Inn` },
]);
const feat = (name, coord, { key = 'place', value = 'city', id = 1 } = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: coord },
  properties: { osm_type: 'N', osm_id: id, osm_key: key, osm_value: value, name, country: 'Testland', countrycode: 'TL' },
});

let mock;
function startMock() {
  const hits = { photon: [], wiki: [], overpass: [], lodgingSeen: false };
  const state = { photonDown: true, wikiOn: false, betaLate: true };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      if (u.pathname.includes('/table/v1/')) {
        const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
        const d = pts.map((p) => Math.hypot((p[0] - pts[0][0]) * 70000, (p[1] - pts[0][1]) * 111000) * 1.2);
        res.end(JSON.stringify({ code: 'Ok', durations: [d.map((x) => x / 1.25)], distances: [d] }));
        return;
      }
      if (u.pathname === '/w/api.php') {
        // Wikipedia: "<Name>" is a disambiguation page; "<Name> City" and "<Name> railway station" have coordinates
        const titles = String(u.searchParams.get('titles') || '').split('|');
        hits.wiki.push(titles);
        if (!state.wikiOn) { res.end(JSON.stringify({ query: { pages: {} } })); return; }
        const pages = {};
        titles.forEach((t, i) => {
          const city = Object.keys(CITIES).find((c) => t === c || t === `${c} City` || t === `${c}, Testland` || t === `${c} railway station`);
          const far = t === 'Gamma City'; // a namesake on another continent: never taken
          if (!city || city === 'Gamma' && !far) { pages[-1 - i] = { title: t, missing: '' }; return; }
          if (t === city) { pages[100 + i] = { pageid: 100 + i, title: t, pageprops: { disambiguation: '' } }; return; }
          const c = far ? [-120, -30] : t.endsWith('railway station') ? CITIES[city].station : CITIES[city].centre;
          pages[200 + i] = { pageid: 200 + i, title: t, coordinates: [{ lat: c[1], lon: c[0], primary: '', globe: 'earth' }] };
        });
        res.end(JSON.stringify({ query: { pages } }));
        return;
      }
      if (u.pathname === '/api/' || u.pathname === '/api') {
        const q = u.searchParams.get('q') || '';
        hits.photon.push(q);
        if (state.photonDown) { res.statusCode = 503; res.end('{}'); return; }
        const tags = u.searchParams.getAll('osm_tag');
        const city = Object.keys(CITIES).find((c) => q === c || q === `${c}, Testland`);
        const answer = city && city !== 'Gamma';
        const features = !answer ? [] : tags.includes('place:city') ? [feat(city, CITIES[city].centre, { id: 100 + Object.keys(CITIES).indexOf(city) })]
          : tags.includes('railway:station') ? [feat(`${city} Station`, CITIES[city].station, { key: 'railway', value: 'station', id: 200 + Object.keys(CITIES).indexOf(city) })] : [];
        res.end(JSON.stringify({ type: 'FeatureCollection', features }));
        return;
      }
      if (u.pathname === '/reverse') { res.end(JSON.stringify({ type: 'FeatureCollection', features: [] })); return; }
      if (u.pathname.includes('interpreter')) {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        hits.overpass.push(q);
        if (!/"tourism"~/.test(q)) {
          // the name search: Alpha at once, Beta only after the first lodging request (busy until then), Gamma never
          const city = ['Alpha', 'Beta'].find((c) => q.includes(c));
          if (!city || (city === 'Beta' && state.betaLate && !hits.lodgingSeen)) { res.statusCode = 504; res.end('{}'); return; }
          const id = 10 + Object.keys(CITIES).indexOf(city);
          const el = /"railway"/.test(q) ? { type: 'node', id: id + 100, lon: CITIES[city].station[0], lat: CITIES[city].station[1], tags: { railway: 'station', name: `${city} Station` } }
            : { type: 'node', id, lon: CITIES[city].centre[0], lat: CITIES[city].centre[1], tags: { place: 'city', name: city, population: '100000' } };
          res.end(JSON.stringify({ elements: [el] }));
          return;
        }
        hits.lodgingSeen = true;
        const answerFor = (part) => {
          const m = part.match(/around:(\d+(?:\.\d+)?),(-?[\d.]+),(-?[\d.]+)/);
          if (!m) return [];
          const near = (c) => Math.hypot((c[0] - Number(m[3])) * 70000, (c[1] - Number(m[2])) * 111000) <= Number(m[1]) * 1.5;
          return LODGING.filter((e) => near(e.c)).map((e) => ({ type: 'node', id: e.id, lon: e.c[0], lat: e.c[1], tags: { tourism: 'hotel', name: e.name } }));
        };
        const parts = q.split(/make uwbatch i="(\d+)";\s*out;/);
        if (parts.length > 1) {
          const elements = [];
          for (let i = 0; i + 1 < parts.length; i += 2) elements.push(...answerFor(parts[i]), { type: 'uwbatch', id: i / 2 + 1, tags: { i: parts[i + 1] } });
          res.end(JSON.stringify({ elements }));
        } else res.end(JSON.stringify({ elements: answerFor(q) }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    }, 20));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, state, close: () => { server.closeAllConnections?.(); server.close(); }, url: `http://127.0.0.1:${server.address().port}` })));
}
const env = (extra = {}) => {
  const e = { ...process.env, UW_CACHE: path.join(tmp, `cache-${Math.random().toString(36).slice(2)}`), UW_PHOTON: mock.url, UW_WIKIPEDIA: mock.url, UW_OVERPASS: mock.url + '/api/interpreter',
    UW_OSRM: mock.url, UW_VALHALLA: mock.url, UW_TURN_BUDGET: '0', INSTAFY_LOOKUP_STATE: path.join(tmp, `health-${Math.random().toString(36).slice(2)}.json`), TMPDIR: path.join(tmp, 'os-tmp'),
    UW_RETRY_PAUSE_MS: '0', UW_APPLY_RAIL_TIMEOUT: '5', UW_APPLY_RAIL_RETRY_WITHIN_S: '0', UW_APPLY_STOP_RETRY_S: '20',
    // the rail track's fallback reads the basemap's tiles: the mock's, never the live tile server
    UW_BASEMAP_TILES: mock.url + '/no-tiles.json', ...extra };
  for (const k of ['INSTAFY_TURN_STARTED_AT', 'INSTAFY_TURN_DEADLINE', 'INSTAFY_TURN_CONTINUE_FILE', 'INSTAFY_STEP_TIMINGS_FILE', 'UW_NO_CACHE', 'UW_JOB_TIMINGS', 'INSTAFY_LOOKUP_PROVIDERS']) if (!(k in extra)) delete e[k];
  return e;
};
const uw = (args, extra = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: env(extra) });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 240000);
  p.on('close', (code) => {
    clearTimeout(t);
    let json = null;
    if (args.includes('--json')) { try { json = JSON.parse(out); } catch { try { json = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)); } catch {} } }
    resolve({ code, out, err, json });
  });
});
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
const stationIds = (site) => {
  const f = path.join(tmp, site, 'data', 'stations.geojson');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).features.map((x) => x.properties.id) : [];
};

function writeHandoff(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const city of Object.keys(CITIES)) {
    fs.writeFileSync(path.join(dir, `${city.toLowerCase()}.json`), JSON.stringify({ schema: 'instafy.research@1', kind: 'city', item: city, country: 'Testland',
      summary: `${city} researched`, facts: [], legs: [], unknowns: [], places: [] }));
  }
}

before(async () => { mock = await startMock(); writeHandoff(path.join(tmp, 'handoff', 'trip')); });
after(() => { mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
test('an expected list is read from "A:3, B" or a JSON array, without duplicates', () => {
  assert.deepEqual(parseExpect('Taipei:3, Hualien:2,Taitung,taipei:1'), [{ name: 'Taipei', nights: 3 }, { name: 'Hualien', nights: 2 }, { name: 'Taitung' }]);
  assert.deepEqual(parseExpect('["Brooks Adrenaline GTS 24", {"name": "Hoka Arahi 7"}]'), [{ name: 'Brooks Adrenaline GTS 24' }, { name: 'Hoka Arahi 7' }]);
  assert.deepEqual(mergeExpect([{ name: 'Porto' }], [{ name: 'porto', nights: 3 }, { name: 'Lisbon', nights: 4 }]), [{ name: 'Porto', nights: 3 }, { name: 'Lisbon', nights: 4 }]);
});

test('a feature stands for an item by its id, stop or a name that names it as a word', () => {
  assert.equal(featureNames({ id: 'hualien', name: '花蓮車站' }, 'Hualien'), true);
  assert.equal(featureNames({ id: 'hualien-hsr' }, 'Hualien'), true);
  assert.equal(featureNames({ id: 'x', name: 'Hualien Station' }, 'Hualien'), true);
  assert.equal(featureNames({ id: 'x', station_of: 'Taitung' }, 'Taitung'), true);
  assert.equal(featureNames({ id: 'x', name: 'Hualienne Bakery' }, 'Hualien'), false, 'a longer word is not the item');
  assert.equal(textNames('京都駅の近く', '京都'), true);
  const fm = new Map([['stations', [{ properties: { id: 'taipei', name: 'Taipei Main Station' } }]]]);
  const cfg = { plan: { days: [{ title: 'Mon 20 Oct · Taipei', text: 'Arrive.' }] } };
  assert.deepEqual(uncovered(cfg, fm, parseExpect('Taipei:3,Hualien:2')).map((g) => [g.name, g.on_map, g.in_plan]), [['Hualien', false, false]]);
  // on the map but in no day of the plan
  fm.get('stations').push({ properties: { id: 'hualien', name: 'Hualien' } });
  assert.deepEqual(uncovered(cfg, fm, parseExpect('Hualien')).map((g) => [g.name, g.on_map, g.in_plan]), [['Hualien', true, false]]);
  assert.deepEqual(uncovered({}, fm, parseExpect('Hualien')), [], 'no plan yet: the map is enough');
});

test('validate fails while a stop asked for is not on the map, from the config or from --expect', async () => {
  const site = 'v-site';
  assert.equal((await uw(['new', site, '--title', 'Trip', '--center', '11,50.5', '--zoom', '7', '--expect', 'Alpha:3,Beta:2'])).code, 0);
  assert.deepEqual(cfgOf(site).expect, [{ name: 'Alpha', nights: 3 }, { name: 'Beta', nights: 2 }]);
  const none = await uw(['validate', site]);
  assert.equal(none.code, 1, none.out);
  assert.match(none.out, /asked for but not on the map: Alpha \(3 nights\), Beta \(2 nights\) \(0 of 2 stops on the map\)/);
  assert.equal((await uw(['add-point', site, '--layer', 'stations', '--at', '10.004,50.002', '--name', 'Alpha Station', '--id', 'alpha'])).code, 0);
  const one = await uw(['validate', site, '--json']);
  assert.equal(one.code, 1);
  assert.deepEqual(one.json.errors.filter((e) => e.path === '$.expect').map((e) => e.message), ['asked for but not on the map: Beta (2 nights) (1 of 2 stops on the map)']);
  assert.equal((await uw(['add-point', site, '--layer', 'stations', '--at', '11.003,50.503', '--name', 'Beta Station', '--id', 'beta'])).code, 0);
  const all = await uw(['validate', site, '--json']);
  assert.deepEqual(all.json.errors.filter((e) => /expect/.test(e.path)), [], JSON.stringify(all.json.errors));
  // a list the config does not carry
  const more = await uw(['validate', site, '--expect', 'Gamma:2', '--json']);
  assert.equal(more.code, 1);
  assert.match(more.json.errors.find((e) => e.path === '$.expect').message, /not on the map: Gamma \(2 nights\)/);
  // only stops with nights: anything else is refused, as by uw new
  const text = await uw(['validate', site, '--expect', 'Gamma']);
  assert.equal(text.code, 2, text.out + text.err);
  assert.match(text.err, /--expect: "Gamma" is not a stop with nights\. Name only the trip's stops with their nights \("Lisbon:3"\)\. Days and stays come from uw plan and uw stay\./);
  // the engine knows the key: no console warning on the page
  assert.match(fs.readFileSync(path.join(SKILL, 'starter', 'engine', 'engine.js'), 'utf8'), /'missing', 'expect'\]/);
});

test('validate counts the stops on the map, also when one of them is in no day of the plan', async () => {
  const site = 'count-site';
  assert.equal((await uw(['new', site, '--title', 'Trip', '--center', '11,50.5', '--zoom', '7', '--expect', 'Alpha:2,Beta:2,Gamma:2'])).code, 0);
  for (const [id, c] of [['beta', '11.003,50.503'], ['gamma', '12.002,51.001']]) {
    assert.equal((await uw(['add-point', site, '--layer', 'stations', '--at', c, '--name', `${id[0].toUpperCase()}${id.slice(1)} Station`, '--id', id])).code, 0);
  }
  // a plan that names only Gamma
  const cfg = cfgOf(site);
  cfg.plan = { title: 'Plan', days: [{ title: 'Mon 2 Nov · Gamma', focus: { layer: 'stations', id: 'gamma' }, items: [] }] };
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1);
  assert.deepEqual(v.json.errors.filter((e) => e.path === '$.expect').map((e) => e.message), ['asked for but not on the map: Alpha (2 nights) (2 of 3 stops on the map)']);
  assert.ok(v.json.errors.some((e) => e.path === '$.plan.days' && /on the map but in no day of the plan: Beta \(2 nights\)/.test(e.message)), JSON.stringify(v.json.errors));
});

test('a city whose plain Wikipedia title is ambiguous is found as "<Name> City" near the map, never a namesake far away', async () => {
  mock.state.wikiOn = true;
  try {
    const site = 'wiki-site';
    await uw(['new', site, '--title', 'Trip', '--center', '11,50.5', '--zoom', '7']);
    const beta = await uw(['station', site, '--city', 'Beta', '--country', 'Testland', '--nights', '2']);
    assert.equal(beta.code, 0, beta.out + beta.err);
    assert.match(beta.out, /City centre: Beta City @ 11,50\.5/);
    assert.match(beta.out, /Added stations:beta — 🚉 Beta railway station @ 11\.003,50\.503/);
    assert.ok(mock.hits.wiki.some((t) => t.includes('Beta') && t.includes('Beta City') && t.includes('Beta, Testland')), JSON.stringify(mock.hits.wiki));
    // "Gamma City" exists only on another continent: not taken as Gamma's centre
    const gamma = await uw(['station', site, '--city', 'Gamma', '--country', 'Testland', '--nights', '2']);
    assert.notEqual(gamma.code, 0, gamma.out);
    assert.doesNotMatch(gamma.out, /City centre: Gamma City/);
    assert.deepEqual(stationIds(site), ['beta']);
  } finally { mock.state.wikiOn = false; }
});

test('handoff --apply keeps the route as "expect", places a late stop on its second try, and says loudly which stop is still missing', async () => {
  const site = 'apply-site';
  await uw(['new', site, '--title', 'Trip', '--center', '11,50.5', '--zoom', '7']);
  mock.hits.lodgingSeen = false;
  const r = await uw(['handoff', path.join(tmp, 'handoff', 'trip'), '--site', site, '--apply', '--route', 'Alpha:3,Beta:2,Gamma:2,Alpha:1', '--start', '2027-05-01', '--no-source-check', '--json']);
  assert.equal(r.code, 3, `exit 3 = requested stops missing\n${r.out.slice(-4000)}${r.err}`);
  assert.deepEqual(cfgOf(site).expect, [{ name: 'Alpha', nights: 4 }, { name: 'Beta', nights: 2 }, { name: 'Gamma', nights: 2 }]);
  // Beta: not found in the first pass, placed on the second try (with its stays), so it is in the plan
  assert.deepEqual(stationIds(site).sort(), ['alpha', 'beta']);
  assert.ok(r.json.timings.steps.some((s) => s.step === 'station Beta (again)' && s.exit === 0), JSON.stringify(r.json.timings.steps.map((s) => [s.step, s.exit])));
  const stays = JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', 'stays.geojson'), 'utf8')).features;
  assert.ok(stays.some((f) => f.properties.stop === 'beta'), 'the late stop got its stays');
  // its first pass listed it as "Not found yet"; placed now, it is no longer listed (r11: the page said Tokyo was not
  // found while it showed Tokyo)
  const missingNames = (cfgOf(site).missing || []).map((m) => m.name);
  assert.ok(!missingNames.includes('Beta'), JSON.stringify(missingNames));
  assert.ok(missingNames.includes('Gamma'), JSON.stringify(missingNames));
  const days = cfgOf(site).plan.days;
  assert.ok(days.some((d) => /Beta/.test(`${d.title} ${d.text}`)), days.map((d) => d.title).join('\n'));
  // Gamma: missing, and said so with its nights
  assert.deepEqual(r.json.missing_stops, [{ name: 'Gamma', nights: 2 }]);
  assert.deepEqual(r.json.nights, { asked: 8, covered: 6 });
  assert.equal(r.json.ok, false);
  // validate fails on it
  const v = await uw(['validate', site, '--json']);
  assert.equal(v.code, 1);
  assert.match(v.json.errors.find((e) => e.path === '$.expect').message, /asked for but not on the map: Gamma \(2 nights\)/);
  assert.equal(v.json.errors.filter((e) => e.path === '$.missing').length, 0, JSON.stringify(v.json.errors));
  // a stale "Not found yet" entry for a stop on the map is an error
  const cfg = cfgOf(site);
  cfg.missing = [...(cfg.missing || []), { name: 'Beta', layer: 'stations', id: 'beta', tried: ['test'] }];
  fs.writeFileSync(path.join(tmp, site, 'map.config.json'), JSON.stringify(cfg, null, 2));
  const stale = await uw(['validate', site, '--json']);
  assert.match(stale.json.errors.find((e) => e.path === '$.missing')?.message ?? '', /listed as not found yet but on the map: Beta/);
});

test('the printed report starts and ends with the requested stops the map leaves out', async () => {
  const site = 'apply-printed';
  await uw(['new', site, '--title', 'Trip', '--center', '11,50.5', '--zoom', '7']);
  const r = await uw(['handoff', path.join(tmp, 'handoff', 'trip'), '--site', site, '--apply', '--route', 'Alpha:3,Gamma:2,Alpha:1', '--start', '2027-05-01', '--no-source-check']);
  assert.equal(r.code, 3, r.out.slice(-3000));
  const report = r.out.slice(r.out.lastIndexOf('\nhandoff --apply:') - 400);
  const first = report.split('\n').find((l) => /REQUESTED BUT NOT ON THE MAP/.test(l));
  assert.equal(first, 'REQUESTED BUT NOT ON THE MAP: Gamma (2 nights). The plan covers 4 of the 6 nights asked for; the map\'s "Not found yet" line names them.');
  const tail = r.out.trimEnd().split('\n').slice(-4).join('\n');
  assert.match(tail, /REQUESTED BUT NOT ON THE MAP: Gamma \(2 nights\)/);
  assert.match(tail, /uw station apply-printed --city Gamma --country Testland --id gamma --nights 2 --timeout 120/);
  assert.ok(r.out.indexOf('REQUESTED BUT NOT ON THE MAP') < r.out.indexOf('handoff --apply:'), 'said before the step count');
});

test('the team handoff recipe has its card before the map job runs, and refreshes it once the job is done', () => {
  // a Taiwan builder whose lookups were slow ran out of turn before its card, so no card was posted although the
  // map was mostly built; the card now goes out right after `uw new` (step 1), before the job
  const recipe = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8').replace(/\s+/g, ' ');
  const handoff = recipe.slice(recipe.indexOf('## Research-team handoff'));
  const open = handoff.indexOf('The card is out since step 1, before the job');
  assert.ok(open > 0, 'the handoff section says the card is out before the job');
  assert.ok(handoff.indexOf('`uw handoff handoff/<task-slug> --site <site> --apply --detach') < open);
  assert.doesNotMatch(recipe, /uw host … --detach|Open it from the card/);
  assert.ok(handoff.indexOf('SKILL.md step 9 comes once the job is done') > open);
});
