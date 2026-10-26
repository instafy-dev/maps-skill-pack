// One lookup mechanism for every outside service (scripts/lookup-providers.json + lib/lookup.mjs): providers are
// declared data, asked in chain order, with one health file every uw command shares. Offline: the providers here are
// declared fakes (INSTAFY_LOOKUP_PROVIDERS) or local stand-in servers; nothing reaches the network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UW = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-chains-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const freshState = () => path.join(fs.mkdtempSync(path.join(tmp, 'state-')), 'health.json');

const uw = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0', INSTAFY_TURN_STARTED_AT: '', UW_CACHE: path.join(tmp, 'cache'), ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 60000);
  p.on('close', (code) => { clearTimeout(t); let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});
const declared = (o) => ({ INSTAFY_LOOKUP_PROVIDERS: JSON.stringify(o) });
const outage = (capability, label = 'Drill') => declared({ providers: { [`drill-${capability}`]: { protocol: 'fake', behaviour: 'unavailable', label } }, chains: { [capability]: [`drill-${capability}`] } });

/** A stand-in place search: answers 503 (busy/down) and counts the requests. */
async function downServer() {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.statusCode = 503; res.end('down'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits: () => hits, close: () => server.close() };
}

test('a declared outage of the place search is "unavailable" (exit 4), never "no such place"', async () => {
  const env = { ...outage('geocode', 'Place search drill'), INSTAFY_LOOKUP_STATE: freshState() };
  const g = await uw(['geocode', 'Shibuya Station, Tokyo', '--json'], env);
  assert.equal(g.code, 4, g.out + g.err);
  assert.equal(g.json.status, 'unavailable');
  assert.match(g.json.error, /Place search drill unavailable/);
  assert.match(g.json.error, /not "no such place"/);
  assert.doesNotMatch(g.out + g.err, /No results/);

  assert.equal((await uw(['new', 'drill', '--title', 'Cafés'], env)).code, 0);
  const a = await uw(['add-point', 'drill', '--layer', 'cafes', '--query', 'Blue Door Cafe, Tokyo', '--json'], env);
  assert.equal(a.code, 4, a.out + a.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'drill', 'map.config.json'), 'utf8'));
  assert.equal(cfg.missing?.[0]?.name, 'Blue Door Cafe', 'listed as "Not found yet", so the reply can say so');
  assert.match(cfg.missing[0].tried.join(' '), /busy: skipped|unavailable/);
});

test('chains are data: a declared provider answers in place of the default one, and its answer says where it came from', async () => {
  const env = {
    INSTAFY_LOOKUP_STATE: freshState(),
    ...declared({
      providers: {
        down: { protocol: 'fake', behaviour: 'unavailable', label: 'Primary search' },
        backup: { protocol: 'fake', behaviour: 'results', label: 'Backup search', results: [{ name: 'Shibuya', type: 'railway=station', kind: 'station', address: '', coord: [139.7016, 35.658], osm_id: 'osm-n1' }] },
      },
      chains: { geocode: ['down', 'backup'] },
    }),
  };
  const g = await uw(['geocode', 'Shibuya Station', '--json'], env);
  assert.equal(g.code, 0, g.err);
  assert.equal(g.json.status, 'ok');
  assert.equal(g.json.candidates[0].provider, 'backup');
  assert.match(g.json.candidates[0].source, /Backup search \(Primary search unavailable\)/);
});

test('one health file for every command: a provider found down is not asked again this turn; the next turn asks it once more', async () => {
  const down = await downServer();
  const state = freshState();
  const env = {
    INSTAFY_LOOKUP_STATE: state,
    ...declared({
      providers: {
        flaky: { protocol: 'photon-search', label: 'Flaky search', base: down.url, timeout_ms: 5000, cooldown_s: 600 },
        backup: { protocol: 'fake', behaviour: 'results', label: 'Backup', results: [{ name: 'Lisbon', type: 'place=city', kind: 'city', address: '', coord: [-9.14, 38.71], osm_id: 'osm-n2' }] },
      },
      chains: { geocode: ['flaky', 'backup'] },
    }),
  };
  try {
    const first = await uw(['geocode', 'Lisbon', '--json'], env);
    assert.equal(first.code, 0, first.err);
    const asked = down.hits();
    assert.ok(asked >= 1, 'the first command asked it (and its retries)');
    const second = await uw(['geocode', 'Lisbon', '--json'], { ...env, INSTAFY_TURN_STARTED_AT: new Date(Date.now() - 60000).toISOString() });
    assert.equal(second.code, 0, second.err);
    assert.equal(down.hits(), asked, 'another command in the same turn skips it without asking');
    const lookups = await uw(['lookups', '--json'], env);
    const geocode = lookups.json.chains.find((c) => c.capability === 'geocode');
    assert.equal(geocode.providers[0].state, 'down');
    assert.ok(geocode.providers[0].retry_after_s > 500);
    const nextTurn = await uw(['geocode', 'Lisbon', '--json'], { ...env, INSTAFY_TURN_STARTED_AT: new Date(Date.now() + 1000).toISOString() });
    assert.equal(nextTurn.code, 0, nextTurn.err);
    assert.ok(down.hits() > asked, 'a newer turn (a person\'s "try again") asks it once more');
    assert.equal((await uw(['lookups', '--reset'], env)).code, 0);
    assert.equal((await uw(['lookups', '--json'], env)).json.chains.find((c) => c.capability === 'geocode').providers[0].state, 'ok');
  } finally {
    down.close();
  }
});

test('places, routes and walking times use the same contract: a declared outage is exit 4 with status unavailable', async () => {
  const state = freshState();
  assert.equal((await uw(['new', 'chains', '--title', 'Chains', '--center', '4.8897,52.3740', '--zoom', '14'], { INSTAFY_LOOKUP_STATE: state })).code, 0);
  const places = await uw(['places', 'chains', '--layer', 'cafes', '--kinds', 'cafe', '--near', '4.8897,52.3740', '--radius', '300', '--json'], { ...outage('places', 'Places drill'), INSTAFY_LOOKUP_STATE: state });
  assert.equal(places.code, 4, places.out + places.err);
  assert.equal(places.json.status, 'unavailable');
  assert.match(places.json.error, /Places drill unavailable/);
  const route = await uw(['route', 'chains', '--layer', 'walk', '--from', '4.8897,52.3740', '--to', '4.8952,52.3702', '--json'], { ...outage('route', 'Routing drill'), INSTAFY_LOOKUP_STATE: state });
  assert.equal(route.code, 4, route.out + route.err);
  assert.equal(route.json.status, 'unavailable');
  assert.deepEqual(route.json.tried.map((t) => t.outcome), ['unavailable']);
});

test('the pack declares its providers as data and the code names no provider', () => {
  const lib = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'lib');
  const decl = JSON.parse(fs.readFileSync(path.join(lib, '..', 'lookup-providers.json'), 'utf8'));
  assert.equal(decl.schema, 'instafy.lookup-providers@1');
  for (const [cap, ids] of Object.entries(decl.chains)) for (const id of ids) assert.ok(decl.providers[id], `${cap} names ${id}`);
  for (const f of fs.readdirSync(lib).filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(lib, f), 'utf8');
    assert.doesNotMatch(src, /photonDown|photonSlow|markPhoton|uw-photon-(down|slow)|uw-overpass-sick|\bENDPOINTS\./, `${f}: a provider special-cased in code`);
    assert.doesNotMatch(src, /https:\/\/(photon\.komoot\.io|routing\.openstreetmap\.de|valhalla1\.openstreetmap\.de|overpass-api\.de|air-quality-api\.open-meteo\.com)/, `${f}: a provider URL in code (declare it in lookup-providers.json)`);
  }
});

test('running out of the command\'s time stops the chain; only a reserve or a cap lets the next provider answer', async () => {
  const net = await import('../skills/interactive-map/scripts/lib/net.mjs');
  net.setDeadline(10000);
  // a step that cannot afford a wait (the Overpass spacing, say) with seconds still left: the command's own limit
  const own = net.deadlineSkip('Overpass');
  assert.equal(own.deadline, true);
  assert.equal(own.slow, false);
  // inside a reserve kept for the next provider, or a cap on an optional step: only this step ran out
  const reserved = await net.withReserve(5000, async () => net.deadlineSkip('Overpass'));
  assert.deepEqual([reserved.deadline, reserved.slow], [false, true]);
  const capped = await net.withCap(1000, async () => net.deadlineSkip('Wikipedia'));
  assert.deepEqual([capped.deadline, capped.slow], [false, true]);
  net.setDeadline(0);
});
