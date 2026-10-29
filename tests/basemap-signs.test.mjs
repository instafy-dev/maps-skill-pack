// Road-number shields drew as blank grey boxes on a dark map: the night look turned every label light and dimmed every
// icon, so a shield's number went light on its light box. A sign (text drawn centred on its own icon) now keeps the
// colours its sprite draws it in at every hour; labels and icons beside their text still follow the night look.
// Offline: the starter's style with a fake map, no tiles.
// Run: node --test tests/basemap-signs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STARTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map', 'starter');
const { Look, isSign } = await import(pathToFileURL(path.join(STARTER, 'engine', 'look.js')).href);
const style = JSON.parse(fs.readFileSync(path.join(STARTER, 'style.json'), 'utf8'));

/** The part of a MapLibre map Look uses, over a style's layers; it records what Look sets. */
function fakeMap(layers) {
  const set = [];
  const byId = new Map(layers.map((l) => [l.id, l]));
  return {
    set,
    getStyle: () => ({ layers }),
    getPaintProperty: (id, prop) => byId.get(id)?.paint?.[prop],
    getLayoutProperty: (id, prop) => byId.get(id)?.layout?.[prop],
    setPaintProperty: (id, prop, v) => set.push({ id, prop, v }),
  };
}

test("isSign: the starter style's signs are its road shields, and only those", () => {
  const signs = style.layers.filter(isSign).map((l) => l.id).sort();
  assert.deepEqual(signs, ['highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us']);
  // text beside its icon (a place's name under its dot, a station's beside its symbol) is a label, not a sign
  assert.equal(isSign({ type: 'symbol', layout: { 'icon-image': 'rail', 'text-field': '{name}', 'text-offset': [0.9, 0], 'text-anchor': 'left' } }), false);
  assert.equal(isSign({ type: 'symbol', layout: { 'icon-image': 'dot', 'text-field': '{name}', 'text-anchor': 'bottom' } }), false);
  assert.equal(isSign({ type: 'symbol', layout: { 'text-field': '{ref}' } }), false, 'text alone');
  // a box fitted to its text is a sign whatever the anchor
  assert.equal(isSign({ type: 'symbol', layout: { 'icon-image': 'box', 'text-field': '{ref}', 'icon-text-fit': 'both', 'text-anchor': 'left' } }), true);
});

test('the night look leaves road shields as their sprite draws them, and still darkens labels and icons', () => {
  const map = fakeMap(style.layers);
  const look = new Look(map, new Set());
  assert.equal(look.apply(1, 0), true);
  const touched = (id) => map.set.filter((s) => s.id === id).map((s) => s.prop);
  for (const id of ['highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us']) {
    assert.deepEqual(touched(id), [], `${id}: its number and box keep their colours at night`);
  }
  // a place's label turns light at night and its icon dims, as before
  assert.ok(touched('poi_r1').includes('text-color') && touched('poi_r1').includes('icon-opacity'), touched('poi_r1').join(', '));
  assert.ok(touched('label_city').includes('text-color'));
  // dusk too
  const dusk = fakeMap(style.layers);
  new Look(dusk, new Set()).apply(0.4, 0.8);
  assert.ok(!dusk.set.some((s) => /shield/.test(s.id)), 'no shield is tinted at dusk');
});
