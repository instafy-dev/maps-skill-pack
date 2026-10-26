// Content gaps from the human-flows recheck (Oct 16-17): the rail track failed to load when Overpass was busy, so
// every leg was a straight arc; every full day still read "Day in Taipei; night 2 of 4" although the lanes had
// researched sights and food; a reply named the handoff and site folders; and the team's shopping page showed no
// price although lanes had read product pages that state one.
//   - `uw lines` over a large area asks for 1.5° map tiles (small queries busy servers still answer), keeps them in
//     the cache every site shares, asks failed tiles again after a pause, and writes what loaded marked PARTIAL;
//   - `uw legs` labels an arc it could not put on the track ("Drawn straight: …"), and the card shows it;
//   - `uw plan` writes a full day's text from its sourced places (name + the page's reason), several layers at once;
//   - `uw validate` flags a "Day in …" text on a day that has sourced places;
//   - `uw handoff` carries a lane's reason (why) and food layer to the map, checks product prices against their
//     page, flags a lane that researched an older generation, and tells the builder to keep paths out of replies.
// Offline: Overpass is a local mock. Run: node --test map-pack/tests/content-gaps.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { tilesFor } = await lib('cmd-lines.mjs');
const { encodeLineTile, decodeTile } = await lib('mvt.mjs');
const { buildPlan, dayTextFrom } = await lib('cmd-plan.mjs');
const { checkHandoff, checkSources, planFromHandoff, pageShowsPrice } = await lib('cmd-handoff.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-gaps-'));
const cache = path.join(tmp, 'shared-cache');
const ownTmp = path.join(tmp, 'os-tmp');
fs.mkdirSync(ownTmp, { recursive: true });

// A main line from the south-west to the north-east of a ~110,000 km² area (6 map tiles of 1.5°), as OSM ways of
// two vertices each; a tile returns every way with a vertex inside it (whole geometry, like `out geom;`).
const LINE = Array.from({ length: 31 }, (_, i) => [Math.round((120.5 + i * 0.05) * 1e6) / 1e6, Math.round((22.2 + i * 0.1) * 1e6) / 1e6]);
const WAYS = LINE.slice(1).map((c, i) => ({ type: 'way', id: 7000 + i, tags: { railway: 'rail', name: 'Main Line', usage: 'main' },
  geometry: [LINE[i], c].map(([lon, lat]) => ({ lat, lon })) }));
const BBOX = [120.0, 22.0, 122.9, 25.4];
let mock;
const mockUrl = () => mock.url;
const px = ([lng, lat], z, x, y) => {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [Math.round((((lng + 180) / 360) * n - x) * 4096), Math.round((((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - y) * 4096)];
};
function basemapTile(z, x, y) {
  const inTile = LINE.map((c) => px(c, z, x, y)).filter(([a, b]) => a >= 0 && a <= 4096 && b >= 0 && b <= 4096);
  if (!inTile.length) return encodeLineTile('transportation', []);
  return encodeLineTile('transportation', [{ properties: { class: 'rail', subclass: 'rail' }, coords: LINE.map((c) => px(c, z, x, y)) },
    { properties: { class: 'rail', subclass: 'rail', service: 'yard' }, coords: [px([121.0, 23.0], z, x, y), px([121.3, 23.0], z, x, y)] }]);
}
const tileKey = (q) => (q.match(/\[bbox:([-\d.,]+)\]/) || [])[1] || '';
function startMock() {
  const hits = [];
  const seen = new Map();
  const state = { failFirst: new Set(), failAlways: new Set() };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // the basemap: a TileJSON and vector tiles that draw LINE (plus a yard siding, never track to ride)
    if (u.pathname === '/tilejson') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tiles: [`${mockUrl()}/t/{z}/{x}/{y}.pbf`] })); return; }
    const tm = u.pathname.match(/^\/t\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (tm) { state.basemapHits = (state.basemapHits || 0) + 1; res.setHeader('content-type', 'application/x-protobuf'); res.end(basemapTile(...tm.slice(1).map(Number))); return; }
    if (u.pathname.startsWith('/nobasemap')) { res.statusCode = 404; res.end('{}'); return; }
    if (u.pathname === '/api' || u.pathname === '/api/') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'FeatureCollection', features: photonAnswer(u.searchParams.get('q'), u.searchParams.get('lang'), u.searchParams.getAll('osm_tag')) }));
      return;
    }
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
      const key = tileKey(q);
      hits.push(key);
      const [s, w, n, e] = key.split(',').map(Number);
      seen.set(key, (seen.get(key) || 0) + 1);
      res.setHeader('content-type', 'application/json');
      const sw = `${s},${w}`;
      if (state.failAlways.has(sw) || (state.failFirst.has(sw) && seen.get(key) === 1)) { res.statusCode = 504; res.end('<html>504 Gateway Timeout</html>'); return; }
      const inside = (g) => g.some((p) => p.lat >= s && p.lat < n && p.lon >= w && p.lon < e);
      res.end(JSON.stringify({ elements: /"railway"/.test(q) ? WAYS.filter((x) => inside(x.geometry)) : [] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, state, reset: () => { hits.length = 0; seen.clear(); }, url: `http://127.0.0.1:${server.address().port}` })));
}
// Photon for Tokyo (Oct 17 rehearsal): OSM maps Tokyo as 東京都 place=province, so a city/town search finds nothing;
// a plain search lists the province, the station and, near the map's first view, a shoe shop named after the city.
const TOKYO = [139.763895, 35.67686], TOKYO_STN = [139.765101, 35.677678], SHOP = [137.505705, 34.900609];
const ph = (name, coord, key, value, id, extra = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coord },
  properties: { osm_type: 'N', osm_id: id, osm_key: key, osm_value: value, name, country: '日本', countrycode: 'JP', ...extra } });
function photonAnswer(q, lang, tags) {
  const en = lang === 'en';
  if (/^Tokyo(, Japan)?$/.test(q || '') && tags.includes('place:city')) return [];
  if (/^Tokyo(, Japan)?$/.test(q || '') && tags.includes('place:province')) return [ph(en ? 'Tokyo' : '東京都', TOKYO, 'place', 'province', 1543125, { country: en ? 'Japan' : '日本', osm_type: 'R' })];
  if (/^(Tokyo|東京都?)$/.test(q || '') && tags.includes('railway:station')) return [ph(en ? 'Tokyo' : '東京', TOKYO_STN, 'railway', 'station', 2149761647)];
  if (q === 'Tokyo' && !tags.length) return [ph(en ? 'Tokyo' : '東京都', TOKYO, 'place', 'province', 1543125, { osm_type: 'R' }), ph(en ? 'Tokyo' : '東京', TOKYO_STN, 'railway', 'station', 2149761647),
    ph(en ? 'Tokyo Shoes Retailing Center' : '東京靴流通センター', SHOP, 'shop', 'shoes', 96030258)];
  return [];
}
const env = () => ({ ...process.env, UW_CACHE: cache, UW_OVERPASS: `${mock.url}/api/interpreter`, UW_PHOTON: mock.url, UW_TURN_BUDGET: '0', UW_RETRY_PAUSE_MS: '200',
  UW_BASEMAP_TILES: `${mock.url}/nobasemap`,
  // its own Overpass lock, spacing and sick-server files: these tile queries never slow another test file's timing
  TMPDIR: ownTmp });
const uw = (args, extra = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...env(), ...extra } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 120000);
  p.on('close', (code) => { clearTimeout(t); let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const readFC = (site, layer) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${layer}.geojson`), 'utf8'));
const cfgOf = (site) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'map.config.json'), 'utf8'));
async function newSite(name) {
  assert.equal((await uw(['new', name, '--title', 'Rail', '--center', '121.4,23.7', '--zoom', '7'])).code, 0);
  for (const [id, c] of Object.entries({ a: LINE[0], b: LINE[30] })) assert.equal((await uw(['add-point', name, '--layer', 'stops', '--at', c.join(','), '--name', id.toUpperCase(), '--id', id])).code, 0);
}

before(async () => { mock = await startMock(); });
after(() => { mock?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('map tiles are aligned to the globe, so every site asks for the same ones', () => {
  const t = tilesFor(BBOX);
  assert.equal(t.length, 6);
  assert.deepEqual(t[0], [120, 21, 121.5, 22.5]);
  assert.deepEqual(tilesFor([120.1, 22.1, 122.8, 25.3]), t, 'a slightly different view asks for the same tiles');
});

test('lines over a large area: one query per tile, a failed tile asked again, then every site reads the shared cache', async () => {
  await newSite('rail1');
  mock.reset();
  mock.state.failFirst = new Set(['22.5,120']); // the middle tile is busy once
  const r = await uw(['lines', 'rail1', '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80', '--bbox', BBOX.join(','), '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.tiles.total, 6);
  assert.equal(r.json.tiles.loaded, 6, 'the busy tile loaded on the second round');
  assert.equal(r.json.partial, null);
  assert.equal(mock.hits.filter((k) => k.startsWith('22.5,120,')).length, 2);
  const fc = readFC('rail1', 'rail');
  assert.equal(fc.uw.partial, undefined);
  const legs = await uw(['legs', 'rail1', '--layer', 'trip', '--stops', 'stops:a,stops:b', '--modes', 'train', '--follow', 'rail', '--json']);
  assert.equal(legs.code, 0, legs.err);
  const leg = readFC('rail1', 'trip').features[0].properties;
  assert.equal(leg.track, true, 'the leg follows the track across all the tiles');
  assert.equal(leg.track_note, undefined);
  // a second site (another space's trip over the same country): no Overpass request at all
  await newSite('rail2');
  mock.reset();
  const again = await uw(['lines', 'rail2', '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80', '--bbox', BBOX.join(','), '--json']);
  assert.equal(again.code, 0, again.err);
  assert.equal(mock.hits.length, 0, 'every tile came from the shared cache');
  assert.equal(again.json.tiles.from_cache, 6);
});

test('a tile that never loads: the layer is written PARTIAL with the command that fetches only the rest; arcs say why', async () => {
  fs.rmSync(cache, { recursive: true, force: true });
  await newSite('rail3');
  mock.reset();
  mock.state.failFirst = new Set();
  mock.state.failAlways = new Set(['24,121.5']); // the north-east tile is down
  const r = await uw(['lines', 'rail3', '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80', '--bbox', BBOX.join(','), '--json']);
  assert.equal(r.code, 0, `partial track is still a map: ${r.err}`);
  assert.equal(r.json.tiles.loaded, 5);
  assert.match(r.json.partial.reason, /rail track for 1 of 6 map tiles did not load/);
  assert.match(r.json.partial.refetch, /^uw lines rail3 --layer rail .*--timeout 180$/);
  assert.match(cfgOf('rail3').layers.find((l) => l.id === 'rail').partial, /1 of 6 map tiles/);
  const legs = await uw(['legs', 'rail3', '--layer', 'trip', '--stops', 'stops:a,stops:b', '--modes', 'train', '--follow', 'rail']);
  assert.equal(legs.code, 0, legs.err);
  const leg = readFC('rail3', 'trip').features[0].properties;
  assert.equal(leg.track, undefined);
  assert.equal(leg.track_note, 'Drawn straight: part of the rail track did not load');
  assert.match(legs.out, /Part of the track did not load: uw lines rail3/);
  // the server is back: the same command asks only for the missing tile and clears the mark
  mock.state.failAlways = new Set();
  mock.reset();
  const fix = await uw(['lines', 'rail3', '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80', '--bbox', BBOX.join(','), '--force', '--json']);
  assert.equal(fix.code, 0, fix.err);
  assert.deepEqual(mock.hits.map((k) => k.split(',').slice(0, 2).join(',')), ['24,121.5']);
  assert.equal(fix.json.partial, null);
  assert.equal(cfgOf('rail3').layers.find((l) => l.id === 'rail').partial, undefined);
});

test('no tile loads at all: exit 4 (skipped), nothing written; legs without the layer say the track did not load', async () => {
  fs.rmSync(cache, { recursive: true, force: true });
  await newSite('rail4');
  mock.state.failAlways = new Set(tilesFor(BBOX).map((t) => `${t[1]},${t[0]}`));
  const r = await uw(['lines', 'rail4', '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80', '--bbox', BBOX.join(','), '--timeout', '20']);
  assert.equal(r.code, 4, r.err);
  assert.equal(fs.existsSync(path.join(tmp, 'rail4', 'data', 'rail.geojson')), false);
  mock.state.failAlways = new Set();
  const legs = await uw(['legs', 'rail4', '--layer', 'trip', '--stops', 'stops:a,stops:b', '--modes', 'train', '--follow', 'rail']);
  assert.equal(legs.code, 0, legs.err);
  assert.equal(readFC('rail4', 'trip').features[0].properties.track_note, 'Drawn straight: the rail track did not load');
});

test('a leg card shows why it is drawn straight', () => {
  const src = fs.readFileSync(path.join(SKILL, 'starter', 'engine', 'engine.js'), 'utf8');
  const fn = src.match(/function legChips\(p\) \{[\s\S]*?\n\}/)[0];
  const legChips = vm.runInNewContext(`(${fn.replace('function legChips', 'function')})`);
  const texts = (p) => legChips(p).map((c) => c.text);
  assert.ok(texts({ distance_km: 300, track_note: 'Drawn straight: the rail track did not load' }).includes('〰 Drawn straight: the rail track did not load'));
  assert.ok(!texts({ track: true, track_km: 320, track_note: 'x' }).some((t) => t.startsWith('〰')), 'a leg on the track has no such chip');
});

// ---------------------------------------------------------------------------
// day texts from sourced places
const stop = (id, city, coord) => ({ id, layer: 'stations', coord, props: { id, station_of: city } });
const place = (layer, id, coord, props) => Object.assign({ type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: { id, ...props } }, { _layer: layer });
const PORTO = [-8.611, 41.145], LISBON = [-9.141, 38.714];

test('uw plan writes what each full day is for from its sourced places; days without any keep "Day in …"', () => {
  const sights = [
    place('sights', 'lello', PORTO, { name: 'Livraria Lello', stop: 'porto', why: 'the 1906 bookshop; timed tickets.', source_url: 'https://www.livrarialello.pt/', source: 'livrarialello.pt' }),
    place('sights', 'clerigos', PORTO, { name: 'Clérigos Tower', stop: 'porto', source_url: 'https://www.torredosclerigos.pt/', source: 'torredosclerigos.pt' }),
    place('food', 'bolhao', PORTO, { name: 'Mercado do Bolhão', stop: 'porto', why: 'the restored food market', source_url: 'https://mercadobolhao.pt/' }),
    place('sights', 'unsourced', PORTO, { name: 'A view from memory', stop: 'porto' }),
  ];
  const plan = buildPlan({ stops: [stop('porto', 'Porto', PORTO), stop('lisbon', 'Lisbon', LISBON)], nights: [3, 3], start: '2027-05-07', sights, perDay: 3 });
  const porto = plan.days.filter((d) => /· Porto$/.test(d.title)).slice(1); // the two full days
  assert.equal(porto.length, 2);
  const texts = porto.map((d) => d.text);
  assert.ok(texts.every((t) => !/^Day in /.test(t)), texts.join(' | '));
  assert.ok(texts.some((t) => /Livraria Lello \(the 1906 bookshop; timed tickets\)/.test(t)), texts.join(' | '));
  assert.ok(texts.some((t) => /Eat: Mercado do Bolhão/.test(t)), 'food is "Eat: …"');
  assert.ok(texts.every((t) => !/from memory/.test(t)), 'an unsourced place never makes it into a text');
  for (const t of texts) assert.ok(t.length <= 140);
  // Lisbon has nothing sourced: its full days stay "Day in …" for the builder to fill
  assert.ok(plan.days.filter((d) => /· Lisbon$/.test(d.title)).slice(1).every((d) => /^Day in Lisbon; night \d of 3\.$/.test(d.text)));
});

test('a day text keeps whole places within 140 characters, the first with its reason when it fits', () => {
  const long = (i) => place('sights', `s${i}`, PORTO, { name: `A rather long sight name number ${i}`, why: 'x'.repeat(60), source_url: 'https://example.org/' });
  const t = dayTextFrom([long(1), long(2), long(3), long(4)]);
  assert.ok(t.length <= 140, t);
  assert.ok(!/…|\.\.\./.test(t));
  assert.match(t, /^A rather long sight name number 1/);
  assert.equal(dayTextFrom([place('daytrips', 'sintra', LISBON, { name: 'Sintra', why: 'palaces in the hills', source_url: 'https://example.org/' })]), 'Day trip: Sintra (palaces in the hills)');
});

test('uw plan --sights takes several layers; validate flags a "Day in …" text on a day with sourced places', async () => {
  assert.equal((await uw(['new', 'days', '--title', 'Days', '--center', '-8.9,40', '--zoom', '6'])).code, 0);
  for (const [id, c] of Object.entries({ porto: PORTO, lisbon: LISBON })) assert.equal((await uw(['add-point', 'days', '--layer', 'stations', '--at', c.join(','), '--name', id, '--id', id])).code, 0);
  assert.equal((await uw(['add-point', 'days', '--layer', 'sights', '--at', '-8.6146,41.1469', '--name', 'Livraria Lello', '--id', 'lello',
    '--props', JSON.stringify({ stop: 'porto', why: 'the 1906 bookshop', source_url: 'https://www.livrarialello.pt/', source: 'livrarialello.pt' })])).code, 0);
  assert.equal((await uw(['add-point', 'days', '--layer', 'food', '--at', '-8.6094,41.1497', '--name', 'Mercado do Bolhão', '--id', 'bolhao',
    '--props', JSON.stringify({ stop: 'porto', source_url: 'https://mercadobolhao.pt/', source: 'mercadobolhao.pt' })])).code, 0);
  const r = await uw(['plan', 'days', '--stops', 'stations', '--ids', 'porto,lisbon', '--nights', '3,2', '--start', '2027-05-07', '--sights', 'sights,food']);
  assert.equal(r.code, 0, r.err);
  const days = cfgOf('days').plan.days;
  const refs = days.flatMap((d) => d.items || []).map((it) => it.ref?.layer).filter(Boolean);
  assert.ok(refs.includes('sights') && refs.includes('food'), 'both layers land on the days');
  assert.match(r.out, /Day texts: \d full day\(s\) say what they are for/);
  assert.match(r.out, /Never in the reply: file or folder names/);
  // put a skeleton back on a day that has places: the validator says so
  const cfg = cfgOf('days');
  const d = cfg.plan.days.find((x) => (x.items || []).some((it) => it.ref?.layer === 'sights'));
  d.text = 'Day in porto; night 2 of 3.';
  fs.writeFileSync(path.join(tmp, 'days', 'map.config.json'), JSON.stringify(cfg, null, 2));
  const v = await uw(['validate', 'days']);
  assert.match(v.out + v.err, /day text is still "Day in …" although the day has sourced places/);
});

// ---------------------------------------------------------------------------
// handoff: why and food for trips, prices and current models for products
const product = (extra = {}) => ({ schema: 'instafy.research@1', item: 'HOKA Arahi', kind: 'product', model: 'Arahi 9', summary: 'Stable, soft.',
  facts: [], places: [], legs: [], unknowns: [], ...extra });

test('handoff: food goes on its own layer with the reason; the builder is told to keep folders out of replies', () => {
  const city = checkHandoff({ schema: 'instafy.research@1', item: 'Porto', kind: 'city', country: 'Portugal', places: [
    { name: 'Mercado do Bolhão', kind: 'food', why: 'the restored food market', source_url: 'https://mercadobolhao.pt/' },
    { name: 'Livraria Lello', kind: 'sight', why: 'the 1906 bookshop', source_url: 'https://www.livrarialello.pt/' }] });
  const plan = planFromHandoff([city.item], 'sites/porto');
  const food = plan.steps.find((s) => /Bolh/.test(s));
  assert.match(food, /--layer food /);
  assert.match(food, /"why":"the restored food market"/);
  assert.match(plan.steps.find((s) => /Lello/.test(s)), /--layer sights .*"why":"the 1906 bookshop"/);
});

test('handoff: product prices need the page, the day and a currency; a lane that researched an older generation is flagged', () => {
  const ok = checkHandoff(product({ prices: [{ store: 'Fleet Feet', amount: 145, currency: 'USD', source_url: 'https://www.fleetfeet.com/p/arahi-9', retrieved_at: '2026-10-17' }] }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.item.prices.length, 1);
  const bad = checkHandoff(product({ successor: 'Arahi 9', model: 'Arahi 7', prices: [
    { amount: '145', currency: 'USD', source_url: 'https://x.test/a', retrieved_at: '2026-10-17' },
    { amount: 145, currency: 'usd', source_url: 'https://x.test/a', retrieved_at: '2026-10-17' },
    { amount: 145, currency: 'USD', retrieved_at: '2026-10-17' },
    { amount: 145, currency: 'USD', source_url: 'https://x.test/a' }] }));
  assert.equal(bad.item.prices.length, 0);
  const text = bad.errors.join('\n');
  assert.match(text, /prices\[0\]\.amount must be a number/);
  assert.match(text, /prices\[1\]\.currency must be a 3-letter code/);
  assert.match(text, /prices\[2\] has no https source_url/);
  assert.match(text, /prices\[3\]\.retrieved_at/);
  assert.match(text, /"successor": "Arahi 9" is newer than the researched model: research the current one/);
  const plan = planFromHandoff([bad.item]);
  assert.ok(plan.unverified.some((u) => /researched Arahi 7, but Arahi 9 is newer/.test(u)));
  assert.ok(plan.notes.some((n) => /no price from a page/.test(n)));
  // a city file never carries prices
  assert.match(checkHandoff({ schema: 'instafy.research@1', item: 'Porto', kind: 'city', country: 'Portugal',
    prices: [{ amount: 90, currency: 'EUR', source_url: 'https://x.test/h', retrieved_at: '2026-10-17' }] }).errors.join('\n'), /prices are for product files/);
});

test('handoff re-reads a price\'s page: a price it shows is carried with store, link and day; one it does not is unverified', async () => {
  const items = [checkHandoff(product({ prices: [
    { store: 'Fleet Feet', amount: 145, currency: 'USD', source_url: 'https://shop.test/arahi-9', retrieved_at: '2026-10-17' },
    { store: 'Old Shop', amount: 99.95, currency: 'USD', source_url: 'https://old.test/arahi', retrieved_at: '2026-10-17' }] })).item];
  const pages = {
    'https://shop.test/arahi-9': { status: 200, type: 'text/html', text: '<p>HOKA Arahi 9</p><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"145.00","priceCurrency":"USD"}}</script>' },
    'https://old.test/arahi': { status: 200, type: 'text/html', text: '<p>HOKA Arahi 9 now $129.95</p>' },
  };
  const s = await checkSources(items, { fetchPage: async (url) => pages[url] });
  assert.equal(s.prices_mismatched, 1);
  assert.equal(s.mismatched, 0, 'a price is not a place');
  const plan = planFromHandoff(items);
  assert.equal(plan.prices.length, 1);
  assert.deepEqual(plan.prices[0], { item: 'HOKA Arahi', model: 'Arahi 9', store: 'Fleet Feet', amount: 145, currency: 'USD', source_url: 'https://shop.test/arahi-9', seen_at: '2026-10-17', checked: true });
  assert.ok(plan.unverified.some((u) => /99\.95 USD at Old Shop \(its page does not show that price now\)/.test(u)));
  assert.equal(pageShowsPrice('Now $1,299.00', 1299), true);
  assert.equal(pageShowsPrice('Now $11,450', 1450), false);
});

test('uw handoff prints the checked prices for the builder', async () => {
  const dir = path.join(tmp, 'handoff', 'shoes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'arahi.json'), JSON.stringify(product({ prices: [{ store: 'Fleet Feet', amount: 145, currency: 'USD', source_url: 'https://shop.test/arahi-9', retrieved_at: '2026-10-17' }] })));
  const r = await uw(['handoff', dir, '--no-source-check']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Prices seen on their pages/);
  assert.match(r.out, /HOKA Arahi \(Arahi 9\): 145 USD at Fleet Feet, seen 2026-10-17 \[https:\/\/shop\.test\/arahi-9\]/);
  const c = await uw(['handoff', '--check', path.join(dir, 'arahi.json')]);
  assert.match(c.out, /1 sourced price\(s\)/);
});

test('a capital mapped as its own province is still found: its station, and a place (never a shop) when no station is', async () => {
  // the map's first view is central Japan, 212 km from Tokyo (the rehearsal's uw new --center)
  assert.equal((await uw(['new', 'jp', '--title', 'Japan', '--center', '137.5,35.2', '--zoom', '7'])).code, 0);
  const st = await uw(['station', 'jp', '--city', 'Tokyo', '--country', 'Japan', '--id', 'tokyo', '--nights', '3']);
  assert.equal(st.code, 0, st.out + st.err);
  assert.match(st.out + st.err, /City centre: 東京都/);
  const tokyo = readFC('jp', 'stations').features.find((f) => f.properties.id === 'tokyo');
  assert.deepEqual(tokyo.geometry.coordinates, TOKYO_STN);
  // handoff --apply's fallback when no station is found: the city, by a place object, however far from the first view
  const c = await uw(['add-point', 'jp', '--layer', 'centres', '--query', 'Tokyo', '--country', 'Japan', '--id', 'tokyo', '--name', 'Tokyo', '--kind', 'city', '--allow-far', '--no-fit', '--json']);
  assert.equal(c.code, 0, c.err);
  assert.deepEqual(readFC('jp', 'centres').features[0].geometry.coordinates, TOKYO, 'the province, not the shoe shop 33 km from the view centre');
});

test('the basemap tiles stand in for rail Overpass cannot give: decoded, yard tracks left out, legs on the track, HSR unknown', async () => {
  // the decoder reads what the encoder wrote (the shape OpenFreeMap serves)
  const t = decodeTile(basemapTile(9, 427, 222), { z: 9, x: 427, y: 222 });
  assert.equal(t.transportation[0].properties.class, 'rail');
  const basemap = { UW_BASEMAP_TILES: `${mock.url}/tilejson` };
  // one tile missing: Overpass gives five, the basemap the sixth
  fs.rmSync(cache, { recursive: true, force: true });
  await newSite('rail5');
  mock.reset();
  mock.state.failFirst = new Set();
  mock.state.failAlways = new Set(['24,121.5']);
  const r = await uw(['lines', 'rail5', '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80', '--bbox', BBOX.join(','), '--json'], basemap);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.partial.fallback, 'basemap');
  assert.match(r.json.partial.reason, /rail track for 1 of 6 map tiles from the basemap tiles/);
  const fc = readFC('rail5', 'rail');
  const bm = fc.features.find((f) => f.properties.basemap);
  assert.ok(bm && bm.properties.hsr_unknown, 'the basemap feature says HSR is unknown');
  assert.match(fc.attribution, /OpenFreeMap/);
  const yard = (bm.geometry.type === 'LineString' ? [bm.geometry.coordinates] : bm.geometry.coordinates).some((l) => l.some(([lng, lat]) => lat === 23 && lng > 121.1));
  assert.equal(yard, false, 'service tracks are not rail to ride');
  const legs = await uw(['legs', 'rail5', '--layer', 'trip', '--stops', 'stops:a,stops:b', '--modes', 'train', '--follow', 'rail']);
  assert.equal(legs.code, 0, legs.err);
  assert.equal(readFC('rail5', 'trip').features[0].properties.track, true, 'the leg follows Overpass and basemap track together');
  // Overpass gives nothing at all: the whole area from the basemap, exit 0
  fs.rmSync(cache, { recursive: true, force: true });
  await newSite('rail6');
  mock.state.failAlways = new Set(tilesFor(BBOX).map((x) => `${x[1]},${x[0]}`));
  mock.state.basemapHits = 0;
  mock.reset();
  const all = await uw(['lines', 'rail6', '--layer', 'rail', '--kinds', 'rail,hsr', '--simplify', '80', '--bbox', BBOX.join(','), '--timeout', '30', '--json'], basemap);
  assert.equal(all.code, 0, all.err);
  assert.match(all.json.partial.reason, /^Overpass was busy: rail track from the basemap tiles/);
  assert.ok(mock.state.basemapHits > 0 && mock.state.basemapHits <= 40);
  assert.equal(mock.hits.length, 6, 'three busy tiles in a row end a round: 2 rounds × 3, not 12 queries');
  mock.state.failAlways = new Set();
  const legs6 = await uw(['legs', 'rail6', '--layer', 'trip', '--stops', 'stops:a,stops:b', '--modes', 'hsr', '--follow', 'rail']);
  assert.equal(legs6.code, 0, legs6.err);
  assert.equal(readFC('rail6', 'trip').features[0].properties.track, true, 'an hsr leg takes the unmarked track');
  const { hsrServesBoth } = await lib('cmd-handoff.mjs');
  assert.equal(hsrServesBoth(readFC('rail6', 'rail'), LINE[0], LINE[30]), null, 'unknown, never "no high-speed line"');
  // some tiles from Overpass with a high-speed line elsewhere, the rest from the basemap: still unknown, not "no"
  const mixed = readFC('rail6', 'rail');
  mixed.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[125, 30], [125.5, 30.5]] }, properties: { kind: 'hsr' } });
  assert.equal(hsrServesBoth(mixed, LINE[0], LINE[30]), null);
  mixed.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [LINE[0], LINE[30]] }, properties: { kind: 'hsr' } });
  assert.equal(hsrServesBoth(mixed, LINE[0], LINE[30]), true);
});
