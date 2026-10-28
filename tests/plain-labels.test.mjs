// The map page speaks to people, not to map makers (28 Oct 2026 drive: a place card read "Baixa · Suburb", another
// "Belém · Administrative", and every card ended "Source: OpenStreetMap search (Photon)"). OpenStreetMap's area classes
// read as plain words, a card's source line says whose data it is, never which search found it, and a new map has no
// subtitle in map-maker words.
// Run: node --test tests/plain-labels.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const ENGINE = path.join(SKILL, 'starter', 'engine');
const { kindLabel, sourceLine } = await import(pathToFileURL(path.join(ENGINE, 'util.js')).href);

test('kindLabel: OpenStreetMap area classes in plain words, other kinds as they are, nothing for a bare "yes"', () => {
  assert.equal(kindLabel('suburb'), 'Neighbourhood');
  assert.equal(kindLabel('quarter'), 'Neighbourhood');
  assert.equal(kindLabel('neighbourhood'), 'Neighbourhood');
  assert.equal(kindLabel('administrative'), 'Area');
  assert.equal(kindLabel('Administrative'), 'Area');
  assert.equal(kindLabel('locality'), 'Area');
  assert.equal(kindLabel('city'), 'City');
  assert.equal(kindLabel('area'), 'Area');
  // kinds that already read as words keep them
  assert.equal(kindLabel('food_court'), 'Food court');
  assert.equal(kindLabel('museum'), 'Museum');
  assert.equal(kindLabel('square'), 'Square');
  assert.equal(kindLabel('B&B'), 'B&B', 'a kind written by hand keeps its letters');
  // a class that says nothing about the place is left out, and so is no kind at all
  for (const k of ['yes', 'house', 'building', '', null, undefined]) assert.equal(kindLabel(k), '', String(k));
  // an object key is not a kind
  assert.equal(kindLabel('constructor'), 'Constructor');
  for (const k of ['suburb', 'administrative', 'quarter', 'locality', 'county', 'state', 'political']) {
    assert.doesNotMatch(kindLabel(k), /suburb|administrative|political|locality/i, k);
  }
});

test('sourceLine: map data is "Map data © OpenStreetMap", never the search that found it; other sources by name', () => {
  const OSM = 'Map data © OpenStreetMap';
  assert.equal(sourceLine({ id: 'baixa', source: 'OpenStreetMap search (Photon)' }), OSM);
  assert.equal(sourceLine({ id: 'baixa', source: 'OpenStreetMap search (Photon) (Overpass unavailable)' }), OSM);
  assert.equal(sourceLine({ id: 'x', source: 'OpenStreetMap (Overpass name search)' }), OSM);
  assert.equal(sourceLine({ id: 'osm-n123456' }), OSM, 'an OpenStreetMap object with no source');
  assert.equal(sourceLine({ id: 'osm-w940449133', source: 'OpenStreetMap' }), OSM, 'no osm.org/way/… id on the card');
  assert.equal(sourceLine({ id: 'x', source: "Wikipedia (its article's coordinates)" }), 'Source: Wikipedia');
  assert.equal(sourceLine({ id: 'x', source: 'Visit Lisboa' }), 'Source: Visit Lisboa');
  assert.equal(sourceLine({ id: 'x' }), '');
  assert.equal(sourceLine(null), '');
  // a place a fallback found says so
  assert.equal(sourceLine({ id: 'x', source: 'OpenStreetMap search (Photon)', data_status: 'partial' }), `${OSM} · data may be incomplete`);
  assert.equal(sourceLine({ id: 'x', data_status: 'partial' }), 'data may be incomplete');
  for (const p of [{ source: 'OpenStreetMap search (Photon)' }, { source: 'OpenStreetMap name search (Overpass) (Photon unavailable)' }]) {
    assert.doesNotMatch(sourceLine(p), /Photon|Overpass|search/, p.source);
  }
});

test('the place cards, the Places list and the hours chip use the plain words; a new map has no jargon subtitle', () => {
  const engine = fs.readFileSync(path.join(ENGINE, 'engine.js'), 'utf8');
  assert.doesNotMatch(engine, /humanize\(p\.kind\)/, 'a kind is shown through kindLabel');
  assert.doesNotMatch(engine, /`Source: \$\{src\}`/, 'the source line comes from sourceLine');
  assert.doesNotMatch(engine, /osm\.org\//, 'no OpenStreetMap object ids on a card');
  assert.equal((engine.match(/\[kindLabel\(p\.kind\), p\.area\]/g) || []).length, 3, 'both card variants and the Places list');
  assert.equal((engine.match(/const foot = sourceLine\(p\);/g) || []).length, 2, 'both card variants');
  const starter = JSON.parse(fs.readFileSync(path.join(SKILL, 'starter', 'map.config.json'), 'utf8'));
  assert.equal(starter.subtitle, undefined, 'no "neighbourhood feel layer" subtitle on a new map');
});

// A `Tell the user` line is copied into the reply (SKILL.md step 4 and Phase C), so it says what happened in the
// person's words: no lookup service, map-data abbreviation or "validated" (28 Oct 2026 drive: "Overpass place search
// was unavailable" reached the reply).
test('every line uw tells the agent to pass on is in plain words', () => {
  const lib = path.join(SKILL, 'scripts', 'lib');
  const lines = fs.readdirSync(lib).filter((f) => f.endsWith('.mjs')).flatMap((f) =>
    [...fs.readFileSync(path.join(lib, f), 'utf8').matchAll(/Tell the user[^'`\n]*/g)].map((m) => `${f}: ${m[0]}`));
  assert.ok(lines.length >= 3, lines.join('\n'));
  const jargon = /\b(OSM|Overpass|Photon|OSRM|Nominatim|Valhalla|validat\w*|exit \d+)\b/;
  assert.deepEqual(lines.filter((line) => jargon.test(line)), []);
});
