// A slow or hung Photon (the pack's one keyless geocoder; Nominatim's policy bans vibe-coding platforms) must not stop a
// map: geocode is skipped (exit 4) with the way on (no --center, uw fit), uw new works without a centre, and once Photon
// was slow, add-point takes a confident Taiwan lodging register match without waiting on it again.
// Offline: Photon is a local mock that never answers (UW_PHOTON=<mock>/hang), the registers a fixture cache (UW_CACHE).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeRegistryCache, startMock, NO_WIKIPEDIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UW = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-slow-'));
const cache = path.join(tmp, 'cache');
let mock;
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: cache, UW_PHOTON: mock.url + '/hang', UW_OVERPASS: mock.url + '/api/interpreter', UW_NO_CACHE: '1', UW_TURN_BUDGET: '0' } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), 60000);
  const t0 = Date.now();
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err, ms: Date.now() - t0 }); });
});
const photonHits = () => mock.hits.filter((h) => h.startsWith('/hang/')).length;

before(async () => { await writeRegistryCache(cache); mock = await startMock(); });
after(() => { mock?.close?.(); mock?.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Photon hangs: geocode says how to go on, the map is built without a centre, hotels come from the register at once', { timeout: 90000 }, async () => {
  const site = await run(['new', 'trip', '--title', 'Taipei by rail']);
  assert.equal(site.code, 0, site.err);

  const g = await run(['geocode', 'Da\'an, Taipei', '--timeout', '3']);
  assert.equal(g.code, 4, g.out + g.err);
  assert.match(g.err, /without --center/);
  assert.match(g.err, /uw fit/);
  assert.match(g.err, /Never stop at the centre step/);

  // Photon was just slow: the register's confident match is taken without asking Photon again (no 45 s wait)
  const before = photonHits();
  const lore = await run(['add-point', 'trip', '--layer', 'hotels', '--query', 'Lore Hotel, Taipei', '--id', 'lore', '--json']);
  assert.equal(lore.code, 0, lore.err);
  const json = JSON.parse(lore.out);
  assert.equal(json.source, 'registry');
  assert.equal(photonHits(), before, 'Photon was not asked');
  assert.ok(lore.ms < 15000, `took ${lore.ms} ms`);
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'trip', 'map.config.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.view?.center), 'the first place framed the map');
  const fit = await run(['fit', 'trip']);
  assert.equal(fit.code, 0, fit.err);
});
