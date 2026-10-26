// Honest, polite lookups (lib/lookup.mjs, lib/net.mjs, lib/budget.mjs):
//   - an empty answer moves on to the next provider (a small venue one search lacks, another may know);
//   - an answer from a fallback is "partial" and says so ("data may be incomplete"), never "ok";
//   - "not_found" only when no provider failed to answer;
//   - HTTP 429 stops that service for the turn (one request, no retries, Retry-After honoured);
//   - no command has an unlimited time; a chain keeps time for its fallbacks;
//   - lookup state lives in a folder that outlasts the turn (INSTAFY_CACHE_DIR), not in the per-turn HOME.
// Offline: every provider is a declared fake or a local stand-in server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts');
const UW = path.join(SCRIPTS, 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-honest-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const freshDir = (name) => fs.mkdtempSync(path.join(tmp, `${name}-`));
const freshState = () => path.join(freshDir('state'), 'health.json');

const uw = (args, env = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_NO_CACHE: '1', UW_TURN_BUDGET: '0', INSTAFY_TURN_STARTED_AT: '', INSTAFY_JOB_DEADLINE: '', UW_CACHE: path.join(tmp, 'cache'), ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(t); let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json, ms: Date.now() - t0 }); });
});
const declared = (o) => ({ INSTAFY_LOOKUP_PROVIDERS: JSON.stringify(o) });
const SMALL_VENUE = { name: 'Kissa Tanpopo', type: 'amenity=cafe', kind: 'cafe', address: '', coord: [139.7016, 35.658], osm_id: 'osm-n77' };

/** A stand-in service that answers every request with `status` (and Retry-After), and records each request. */
async function stubServer(status, { retryAfter = null, body = '{}' } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, ua: req.headers['user-agent'] });
    req.on('data', () => {});
    req.on('end', () => {
      res.statusCode = status;
      if (retryAfter) res.setHeader('retry-after', String(retryAfter));
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() };
}

// ---------------------------------------------------------------------------------------------------------------
// Chain rules (P1) and status honesty (P2), at the chain itself

const lookup = await import('../skills/interactive-map/scripts/lib/lookup.mjs');
const registryOf = (providers, chains, chain_rules = {}) => lookup.loadProviders({ providers, chains, chain_rules }, { overrides: [] });
const healthAt = () => new lookup.Health({ file: freshState(), env: {} });

test('an empty answer asks the next provider; what it finds is a fallback: partial, with via and reason', async () => {
  const registry = registryOf({
    search: { protocol: 'fake', behaviour: 'not_found', label: 'Main search' },
    names: { protocol: 'fake', behaviour: 'results', label: 'Name search', results: [SMALL_VENUE] },
  }, { geocode: ['search', 'names'] });
  const r = await lookup.runChain('geocode', { q: 'Kissa Tanpopo' }, { registry, health: healthAt() });
  assert.equal(r.status, 'partial', 'found by a fallback: never presented as complete');
  assert.deepEqual(r.results.map((c) => c.name), ['Kissa Tanpopo']);
  assert.equal(r.provider, 'names');
  assert.deepEqual(r.via, ['names']);
  assert.equal(r.fallback, true);
  assert.match(r.reason, /fallback: Main search found nothing/);
});

test('"not_found" only when no provider failed: an empty answer while another could not answer is "unavailable"', async () => {
  const both = registryOf({
    search: { protocol: 'fake', behaviour: 'not_found', label: 'Main search' },
    names: { protocol: 'fake', behaviour: 'unavailable', label: 'Name search' },
  }, { geocode: ['search', 'names'] });
  const r = await lookup.runChain('geocode', { q: 'x' }, { registry: both, health: healthAt() });
  assert.equal(r.status, 'unavailable', 'the name search could not answer: nothing is proven');
  assert.match(r.reason, /Name search unavailable/);
  const empty = registryOf({
    search: { protocol: 'fake', behaviour: 'not_found', label: 'Main search' },
    names: { protocol: 'fake', behaviour: 'not_found', label: 'Name search' },
  }, { geocode: ['search', 'names'] });
  assert.equal((await lookup.runChain('geocode', { q: 'x' }, { registry: empty, health: healthAt() })).status, 'not_found');
});

test('a capability whose first provider is authoritative for "none here" declares on_empty "stop"; overrides keep it', async () => {
  const providers = {
    overpass: { protocol: 'fake', behaviour: 'not_found', label: 'Overpass' },
    reverse: { protocol: 'fake', behaviour: 'results', label: 'Reverse', complete: false, results: [SMALL_VENUE] },
  };
  const registry = lookup.loadProviders({ providers, chains: { places: ['overpass', 'reverse'] }, chain_rules: { places: { on_empty: 'stop' } } },
    { overrides: [{ chains: { places: ['overpass', 'reverse'] } }] });
  const r = await lookup.runChain('places', {}, { registry, health: healthAt() });
  assert.equal(r.status, 'not_found');
  assert.throws(() => lookup.loadProviders({ providers, chains: {}, chain_rules: { places: { on_empty: 'maybe' } } }, { overrides: [] }), /on_empty/);
  // one request may still say "stop" for itself (the caller has its own next step)
  const geo = registryOf(providers, { geocode: ['overpass', 'reverse'] });
  assert.equal((await lookup.runChain('geocode', {}, { registry: geo, health: healthAt(), onEmpty: 'stop' })).status, 'not_found');
  assert.equal((await lookup.runChain('geocode', {}, { registry: geo, health: healthAt() })).status, 'partial');
});

test('the pack\'s geocode chain moves on after an empty answer; places stops (an empty Overpass answer is authoritative)', () => {
  const decl = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'lookup-providers.json'), 'utf8'));
  const registry = lookup.loadProviders(decl, { overrides: [] });
  assert.equal(lookup.onEmptyOf(registry, 'geocode'), 'next');
  assert.equal(lookup.onEmptyOf(registry, 'places'), 'stop');
  for (const [id, p] of Object.entries(decl.providers)) {
    if (p.cache) assert.ok(p.cache.ttl_s > 0 && typeof p.cache.allowed === 'boolean', `${id}: a cache policy has a ttl`);
  }
});

test('a chain keeps time for its fallbacks: a hanging first provider is cut short, the next one answers in time', async () => {
  const registry = registryOf({
    hang: { protocol: 'fake', behaviour: 'slow', label: 'Hanging search', timeout_ms: 60000 },
    names: { protocol: 'fake', behaviour: 'results', label: 'Name search', results: [SMALL_VENUE] },
  }, { geocode: ['hang', 'names'] });
  const health = healthAt();
  const t0 = Date.now();
  const r = await lookup.runChain('geocode', {}, { registry, health, deadlineAt: Date.now() + 8000 });
  assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms: the 60 s provider did not take the whole budget`);
  assert.equal(r.status, 'partial');
  assert.equal(r.provider, 'names');
  const hang = lookup.resolveProvider(registry, 'hang');
  assert.equal(health.check(hang, { base: hang.base }).allow, true, 'cut short for time: slow, not marked down');
  assert.equal(health.check(hang, { base: hang.base }).slow, true);
  // no time left at all: the provider is not asked (reason "budget"), never a hang past the command's limit
  const late = await lookup.runChain('geocode', {}, { registry, health: healthAt(), deadlineAt: Date.now() + 500 });
  assert.equal(late.status, 'unavailable');
  assert.ok(late.attempts.every((a) => a.outcome === 'skipped_budget'));
});

// ---------------------------------------------------------------------------------------------------------------
// The commands: partial labels in replies and pages

test('geocode: a small venue the first search lacks is found by the next provider, labelled partial', async () => {
  const env = {
    INSTAFY_LOOKUP_STATE: freshState(),
    ...declared({
      providers: {
        main: { protocol: 'fake', behaviour: 'not_found', label: 'Main search' },
        names: { protocol: 'fake', behaviour: 'results', label: 'Name search', results: [SMALL_VENUE] },
      },
      chains: { geocode: ['main', 'names'] },
    }),
  };
  const g = await uw(['geocode', 'Kissa Tanpopo', '--near', '139.70,35.66', '--json'], env);
  assert.equal(g.code, 0, g.out + g.err);
  assert.equal(g.json.status, 'partial');
  const c = g.json.candidates[0];
  assert.equal(c.name, 'Kissa Tanpopo');
  assert.equal(c.data_status, 'partial');
  assert.deepEqual(c.data_missing, ['address', 'country']);
  assert.match(g.err, /^PARTIAL: place search — fallback: Main search found nothing; no address or country from Name search — data may be incomplete/m);

  // add-point: the point on the page carries the label too
  assert.equal((await uw(['new', 'venue', '--title', 'Cafés', '--center', '139.70,35.66', '--zoom', '15'], env)).code, 0);
  const a = await uw(['add-point', 'venue', '--layer', 'cafes', '--query', 'Kissa Tanpopo', '--near', '139.70,35.66', '--json'], env);
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(a.json.status, 'partial');
  const props = JSON.parse(fs.readFileSync(path.join(tmp, 'venue', 'data', 'cafes.geojson'), 'utf8')).features[0].properties;
  assert.equal(props.data_status, 'partial');
  assert.match(props.data_note, /data may be incomplete/);
  assert.match(a.err, /^PARTIAL: cafes:kissa-tanpopo Kissa Tanpopo — /m);
});

test('HTTP 429: one request, no retries, the service is not asked again this turn (Retry-After holds into the next)', async () => {
  const limited = await stubServer(429, { retryAfter: 900 });
  try {
    const env = {
      INSTAFY_LOOKUP_STATE: freshState(),
      ...declared({
        providers: {
          limited: { protocol: 'photon-search', label: 'Busy search', base: limited.url, timeout_ms: 5000, cooldown_s: 60 },
          backup: { protocol: 'fake', behaviour: 'results', label: 'Backup', results: [{ ...SMALL_VENUE, address: 'Shibuya', country: 'Japan' }] },
        },
        chains: { geocode: ['limited', 'backup'] },
      }),
    };
    const first = await uw(['geocode', 'Kissa Tanpopo', '--json'], env);
    assert.equal(first.code, 0, first.err);
    assert.equal(limited.hits.length, 1, 'asked once: a 429 is never retried');
    assert.match(first.err, /Busy search asked us to slow down \(HTTP 429\): not asked again this turn/);
    assert.equal(first.json.status, 'partial');
    const again = await uw(['geocode', 'Kissa Tanpopo', '--json'], env);
    assert.equal(again.code, 0, again.err);
    assert.equal(limited.hits.length, 1, 'another command in the same turn does not ask it');
    // a new turn starts, but the service said "retry after 900 s": still not asked
    const next = await uw(['geocode', 'Kissa Tanpopo', '--json'], { ...env, INSTAFY_TURN_STARTED_AT: new Date(Date.now() + 1000).toISOString() });
    assert.equal(next.code, 0, next.err);
    assert.equal(limited.hits.length, 1, 'its Retry-After is honoured across turns');
    // every request carried a clear User-Agent with a contact URL
    assert.match(limited.hits[0].ua, /^instafy-map-pack\/[\d.]+ \(\+https:\/\/github\.com\/instafy-dev\/maps-skill-pack; contact: https:\/\/github\.com\/instafy-dev\/maps-skill-pack\/issues\)$/);
  } finally {
    limited.close();
  }
});

test('Overpass answering 429 is asked once per mirror and command, not in rounds; a batch says it was not answered', async () => {
  const limited = await stubServer(429);
  const state = freshState();
  try {
    assert.equal((await uw(['new', 'limits', '--title', 'Limits', '--center', '4.8897,52.3740', '--zoom', '14'], { INSTAFY_LOOKUP_STATE: state })).code, 0);
    const env = { INSTAFY_LOOKUP_STATE: state, UW_OVERPASS: `${limited.url}/api/interpreter`, ...declared({ chains: { places: ['overpass'] } }) };
    const p = await uw(['places', 'limits', '--layer', 'cafes', '--kinds', 'cafe', '--near', '4.8897,52.3740', '--radius', '300', '--timeout', '60', '--json'], env);
    assert.equal(p.code, 4, p.out + p.err);
    assert.equal(limited.hits.length, 1, 'no second round against a mirror that asked us to slow down');
    assert.ok(p.ms < 20000, `${p.ms} ms: no backoff rounds`);
    const again = await uw(['places', 'limits', '--layer', 'cafes', '--kinds', 'cafe', '--near', '4.8897,52.3740', '--radius', '300', '--json'], env);
    assert.equal(again.code, 4);
    assert.equal(limited.hits.length, 1, 'not asked again this turn');
  } finally {
    limited.close();
  }
  // overpassBatch: a batch that was asked and not answered says so (callers pass it on)
  const batchServer = await stubServer(503);
  try {
    const r = await new Promise((resolve) => {
      const code = `const net = await import(${JSON.stringify(path.join(SCRIPTS, 'lib', 'net.mjs'))}); net.setDeadline(20000);
        const r = await net.overpassBatch(['[out:json][timeout:25];\\nnode(1);\\nout;', '[out:json][timeout:25];\\nnode(2);\\nout;'], { timeoutS: 25 });
        process.stdout.write(JSON.stringify({ items: r, unavailable: r.unavailable || null }));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, UW_NO_CACHE: '1', UW_OVERPASS: `${batchServer.url}/api/interpreter`, INSTAFY_LOOKUP_STATE: freshState() } });
      let out = ''; child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(JSON.parse(out)));
    });
    assert.equal(r.unavailable.asked, 2);
    assert.ok(r.items.every((x) => x?.unavailable === true && x.reason), JSON.stringify(r.items));
  } finally {
    batchServer.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Time budget (P3) and where state lives

test('no command has an unlimited time: --timeout 0, a background job and handoff --apply all get a ceiling', async () => {
  const b = await import('../skills/interactive-map/scripts/lib/budget.mjs');
  const env = {};
  assert.equal(b.commandLimitS({ defaultS: 45, given: 0, env }), b.MAX_COMMAND_S, '--timeout 0 is the longest allowed, not "none"');
  assert.ok(b.MAX_COMMAND_S < 600, 'below a 10-minute run limit');
  assert.equal(b.commandLimitS({ defaultS: 45, given: 3600, env }), b.MAX_COMMAND_S);
  assert.equal(b.commandLimitS({ defaultS: 90, selfPaced: true, env }), b.APPLY_BUDGET_S);
  assert.equal(b.commandLimitS({ defaultS: 45, env }), 45);
  assert.equal(b.commandLimitS({ defaultS: 45, given: 0, env: { UW_MAX_COMMAND_S: '9999' } }), b.MAX_COMMAND_S, 'the ceiling can only be lowered');
  const now = Date.parse('2026-10-26T10:00:00Z');
  const job = { INSTAFY_JOB_DEADLINE: '2026-10-26T10:00:20Z' };
  assert.equal(b.commandLimitS({ defaultS: 45, now, env: job }), 20, 'a step of a run ends with the run');
  assert.equal(b.commandLimitS({ defaultS: 45, now, hostDeadlineMs: now + 100_000, hostMarginS: 45 }), 45);
  assert.equal(b.commandLimitS({ defaultS: 120, now, hostDeadlineMs: now + 100_000, hostMarginS: 45 }), 55);
  assert.equal(b.runOutOfTime({ INSTAFY_JOB_DEADLINE: '2026-10-26T10:00:01Z' }, now), true);
  assert.equal(b.jobDeadlineValue(now + 60_000, job), '2026-10-26T10:00:20.000Z', 'never later than the run it belongs to');

  // a step started after its run's budget is used up is skipped at once (exit 4), with one line saying so
  const r = await uw(['geocode', 'Lisbon', '--timeout', '0'], { INSTAFY_JOB_DEADLINE: new Date(Date.now() - 1000).toISOString(), INSTAFY_LOOKUP_STATE: freshState() });
  assert.equal(r.code, 4, r.out + r.err);
  assert.match(r.err, /^skipped: the run this step belongs to has used its time budget/m);
  assert.ok(r.ms < 5000);
});

test('lookup state and shared answers live in the runtime\'s stable folder (INSTAFY_CACHE_DIR), not the per-turn HOME', async () => {
  const net = await import('../skills/interactive-map/scripts/lib/net.mjs');
  const stable = freshDir('space-cache');
  assert.equal(lookup.stateDir({ INSTAFY_CACHE_DIR: stable }), path.join(stable, 'lookups'));
  assert.equal(lookup.defaultStateFile({ INSTAFY_CACHE_DIR: stable }), path.join(stable, 'lookups', 'lookup-health.json'));
  assert.equal(net.sharedCacheRoot({ INSTAFY_CACHE_DIR: stable }), path.join(stable, 'interactive-map'));
  assert.equal(net.sharedCacheRoot({ INSTAFY_CACHE_DIR: stable, UW_CACHE: '/x' }), '/x', 'an explicit UW_CACHE wins');
  assert.equal(lookup.defaultStateFile({ INSTAFY_CACHE_DIR: stable, INSTAFY_LOOKUP_STATE: '/y/h.json' }), '/y/h.json');

  // two tool turns, each with a fresh HOME and TMPDIR: the second still knows the service the first found down
  const down = await stubServer(503);
  try {
    const turn = () => { const home = freshDir('home'); return { HOME: home, TMPDIR: home, XDG_CACHE_HOME: '', INSTAFY_LOOKUP_STATE: '', UW_CACHE: '', INSTAFY_CACHE_DIR: stable }; };
    const env = declared({
      providers: {
        flaky: { protocol: 'photon-search', label: 'Flaky search', base: down.url, timeout_ms: 5000, cooldown_s: 600 },
        backup: { protocol: 'fake', behaviour: 'results', label: 'Backup', results: [{ ...SMALL_VENUE, address: 'Shibuya', country: 'Japan' }] },
      },
      chains: { geocode: ['flaky', 'backup'] },
    });
    const started = new Date(Date.now() - 60000).toISOString();
    assert.equal((await uw(['geocode', 'Kissa Tanpopo'], { ...env, ...turn(), INSTAFY_TURN_STARTED_AT: started })).code, 0);
    const asked = down.hits.length;
    assert.ok(asked >= 1);
    assert.ok(fs.existsSync(path.join(stable, 'lookups', 'lookup-health.json')), 'the health file is in the stable folder');
    assert.equal((await uw(['geocode', 'Kissa Tanpopo'], { ...env, ...turn(), INSTAFY_TURN_STARTED_AT: started })).code, 0);
    assert.equal(down.hits.length, asked, 'a fresh HOME does not forget it: not asked again within its cooldown');
  } finally {
    down.close();
  }
});

test('station: a station found by a fallback is placed as partial, never as a complete answer', async () => {
  const env = {
    INSTAFY_LOOKUP_STATE: freshState(),
    ...declared({
      providers: {
        main: { protocol: 'fake', behaviour: 'not_found', label: 'Main search' },
        names: { protocol: 'fake', behaviour: 'results', label: 'Name search', results: [{ name: 'Hualien', type: 'railway=station', kind: 'train_station', address: '', coord: [121.6014, 23.9932], osm_id: 'osm-n9' }] },
      },
      chains: { geocode: ['main', 'names'] },
    }),
  };
  assert.equal((await uw(['new', 'rail', '--title', 'Rail', '--center', '121.60,23.99', '--zoom', '13'], env)).code, 0);
  const s = await uw(['station', 'rail', '--city', 'Hualien', '--near', '121.60,23.99', '--json'], env);
  assert.equal(s.code, 0, s.out + s.err);
  assert.equal(s.json.status, 'partial');
  const props = JSON.parse(fs.readFileSync(path.join(tmp, 'rail', 'data', 'stations.geojson'), 'utf8')).features[0].properties;
  assert.equal(props.data_status, 'partial');
  assert.match(props.data_note, /data may be incomplete/);
  assert.match(s.err, /^PARTIAL: stations:hualien Hualien — /m);
});

test('commands run one after another in a turn: an explicit --timeout late in the turn gets only what is left of it', async () => {
  const b = await import('../skills/interactive-map/scripts/lib/budget.mjs');
  assert.equal(b.commandLimitS({ defaultS: 45, given: 0, turnHardLeftS: 100, env: {} }), 100, '--timeout 0 late in a turn');
  assert.equal(b.commandLimitS({ defaultS: 45, given: 300, turnHardLeftS: 100, env: {} }), 100, 'an explicit --timeout');
  assert.equal(b.commandLimitS({ defaultS: 90, selfPaced: true, turnHardLeftS: 50, env: {} }), 50, 'handoff --apply');
  assert.equal(b.commandLimitS({ defaultS: 45, given: 0, turnHardLeftS: -30, env: {} }), 10, 'past the limit: a short try, never none');

  // a turn 9m20s in (the pack's own turn clock, no host clock): add-point --timeout 0 against a service that never
  // answers ends in seconds, not after the 9-minute command ceiling
  const hang = http.createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const env = {
      UW_TURN_BUDGET: undefined, INSTAFY_LOOKUP_STATE: freshState(),
      ...declared({ providers: { hang: { protocol: 'photon-search', label: 'Hanging search', base: `http://127.0.0.1:${hang.address().port}`, timeout_ms: 0 } }, chains: { geocode: ['hang'] } }),
    };
    assert.equal((await uw(['new', 'late', '--title', 'Late', '--center', '139.70,35.66', '--zoom', '15'], env)).code, 0);
    const now = Date.now();
    fs.writeFileSync(path.join(tmp, 'late', '.uwcache', 'turn.json'), JSON.stringify({ started: now - 560_000, last: now }));
    const r = await uw(['add-point', 'late', '--layer', 'cafes', '--query', 'Kissa Tanpopo', '--near', '139.70,35.66', '--timeout', '0'], env);
    assert.equal(r.code, 4, r.out + r.err);
    assert.ok(r.ms < 40_000, `ended after ${r.ms} ms`);
  } finally {
    hang.closeAllConnections?.();
    hang.close();
  }
});

test('a read-only state folder (no INSTAFY_CACHE_DIR, a read-only HOME) still limits concurrent requests to a service', async () => {
  const ro = freshDir('readonly');
  fs.chmodSync(ro, 0o500);
  try {
    const env = { XDG_CACHE_HOME: path.join(ro, 'cache') };
    assert.ok(lookup.slotsDir(env).startsWith(os.tmpdir()), lookup.slotsDir(env));
    const p = { id: 'svc', base: `http://slots-${process.pid}-${Date.now()}.example`, max_concurrent: 1 };
    let now = 0, most = 0;
    const work = () => lookup.withProviderSlot(p, async () => { now++; most = Math.max(most, now); await new Promise((r) => setTimeout(r, 150)); now--; }, { env, waitMs: 5000 });
    await Promise.all([work(), work(), work()]);
    assert.equal(most, 1, 'one request at a time, as declared');
  } finally {
    fs.chmodSync(ro, 0o700);
  }
});
