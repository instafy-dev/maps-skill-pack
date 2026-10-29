// A place's own name before a place named after it (the 27 Oct 2026 live test: "Padrão dos Descobrimentos" was put
// on the map as "Miradouro do Padrão dos Descobrimentos", the viewpoint on the monument, because the search listed it
// first). Offline: the place search is the fixtures' mock (UW_PHOTON / UW_OVERPASS).
// Run: node --test tests/geocode-exact-name.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMock, NO_WIKIPEDIA } from './fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'skills', 'interactive-map', 'scripts');
const UW = path.join(SCRIPTS, 'uw.mjs');
const { nameCloseness } = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'cmd-geocode.mjs')).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-exact-'));
let mock;
before(async () => { mock = await startMock(); });
after(() => { mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const uw = (...args) => new Promise((resolve) => {
  const env = { ...process.env, ...NO_WIKIPEDIA, UW_CACHE: path.join(tmp, 'cache'), UW_PHOTON: mock.url, UW_OVERPASS: mock.url + '/api/interpreter', UW_NO_CACHE: '1' };
  delete env.INSTAFY_CACHE_DIR;
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch {} resolve({ code, out, err, json }); });
});
const BELEM = '-9.2057,38.6936';

test('nameCloseness: the same name, every word of it, or only a name that contains it', () => {
  const q = 'Padrão dos Descobrimentos';
  assert.equal(nameCloseness(q, ['Padrão dos Descobrimentos']), 3);
  assert.equal(nameCloseness('Padrao dos descobrimentos, Lisboa', ['Padrão dos Descobrimentos']), 3, 'accents, case and the area after a comma do not count');
  assert.equal(nameCloseness('Descobrimentos Padrão', ['Padrão dos Descobrimentos']), 2, 'every word and no other');
  assert.equal(nameCloseness(q, ['Miradouro do Padrão dos Descobrimentos']), 1, 'a place named after it');
  assert.equal(nameCloseness(q, ['Torre de Belém', null]), 0);
  assert.equal(nameCloseness('Belém Tower', ['Torre de Belém', 'Belém Tower'], ['Belém']), 3, 'its English name counts');
  // a word the query does not have, even a generic one, makes it a place named after it: a hotel named after a church
  // is not the church ("hotel" never makes a name match, but it is still a word the query did not say)
  assert.equal(nameCloseness('Sacré-Cœur', ['Hôtel du Sacré-Cœur'], ['Montmartre', 'Paris']), 1);
  assert.equal(nameCloseness('Sacré-Cœur', ['Café Sacré-Cœur'], ['Montmartre', 'Paris']), 1);
  assert.equal(nameCloseness('Hotel Avenida Palace', ['Avenida Palace']), 2, 'a generic word the query has may be left out');
});

test('add-point: the landmark the search listed first, not a hotel or café named after it', async () => {
  const MONTMARTRE = '2.3430,48.8867';
  assert.equal((await uw('new', 'paris', '--title', 'Paris', '--center', MONTMARTRE, '--zoom', '15')).code, 0);
  const r = await uw('add-point', 'paris', '--layer', 'sights', '--query', 'Sacré-Cœur', '--near', MONTMARTRE, '--id', 'sacre-coeur', '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.chosen.name, 'Basilique du Sacré-Cœur');
  assert.equal(r.json.chosen.type, 'amenity=place_of_worship');
});

test('add-point: the monument, not the viewpoint named after it that the search listed first; the zoo, not its metro station', async () => {
  assert.equal((await uw('new', 'lx', '--title', 'Lisbon', '--center', BELEM, '--zoom', '14')).code, 0);
  const r = await uw('add-point', 'lx', '--layer', 'sights', '--query', 'Padrão dos Descobrimentos', '--near', BELEM, '--strict-name', '--id', 'padrao', '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.chosen.name, 'Padrão dos Descobrimentos');
  assert.equal(r.json.chosen.type, 'historic=monument');
  assert.ok(r.json.alternatives.some((c) => c.name === 'Miradouro do Padrão dos Descobrimentos'), 'the viewpoint stays an alternative (--pick)');
  const feat = JSON.parse(fs.readFileSync(path.join(tmp, 'lx', 'data', 'sights.geojson'), 'utf8')).features.find((f) => f.properties.id === 'padrao');
  assert.equal(feat.properties.name, 'Padrão dos Descobrimentos');
  // (a guard on the rule above) a station named after a place is never preferred for its exact name: the zoo stays
  const z = await uw('add-point', 'lx', '--layer', 'sights', '--query', 'Jardim Zoológico', '--near', '-9.1700,38.7430', '--id', 'zoo', '--json');
  assert.equal(z.code, 0, z.err);
  assert.equal(z.json.chosen.name, 'Jardim Zoológico de Lisboa');
  // a query that names a kind of transit may get it by its exact name: the airport, not a stop named after it
  const a = await uw('add-point', 'lx', '--layer', 'sights', '--query', 'Lisbon Airport', '--near', '-9.1340,38.7740', '--id', 'airport', '--json');
  assert.equal(a.code, 0, a.err);
  assert.equal(a.json.chosen.type, 'aeroway=aerodrome');
});

// The 29 Oct 2026 drive: "Rossio, Lisbon" (a square Visit Lisboa lists) went on the map as Rossio railway station,
// "Station" on its card, because OpenStreetMap names the square "Praça Dom Pedro IV" and the name search found only the
// station. A station is named after the place it serves: the place of that name next to it is the pick.
test('add-point: a square named like its station is the square, under the name asked for; a station asked for stays one', async () => {
  const BAIXA = '-9.137024,38.710124';
  assert.equal((await uw('new', 'rossio', '--title', 'Lisbon', '--center', BAIXA, '--zoom', '14')).code, 0);
  const r = await uw('add-point', 'rossio', '--layer', 'sights', '--query', 'Rossio, Lisbon', '--country', 'Portugal', '--strict-name', '--near', BAIXA, '--json');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.chosen.type, 'place=square');
  assert.ok(r.json.alternatives.some((c) => c.type === 'railway=station'), 'the station stays an alternative (--pick)');
  const feat = JSON.parse(fs.readFileSync(path.join(tmp, 'rossio', 'data', 'sights.geojson'), 'utf8')).features[0];
  assert.equal(feat.properties.id, 'rossio');
  assert.equal(feat.properties.kind, 'square');
  assert.equal(feat.properties.name_en, 'Rossio', 'shown under the name asked for');
  assert.equal(feat.properties.name, 'Praça Dom Pedro IV', 'its own name is on the card under it');
  // a query that asks for the station gets the station
  const s = await uw('add-point', 'rossio', '--layer', 'stations', '--query', 'Rossio, Lisbon', '--kind', 'train_station', '--near', BAIXA, '--id', 'rossio-station', '--json');
  assert.equal(s.code, 0, s.err);
  assert.match(s.json.chosen.type, /^(railway=station|building=train_station)$/);
});
