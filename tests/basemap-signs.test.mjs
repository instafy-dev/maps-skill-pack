// Road-number shields drew as blank grey boxes on a dark map: the night look turned every label light and dimmed every
// icon, so a shield's number went light on its light box. Kept as the sprite draws them, they were glaring light boxes
// on the dark map instead. A sign (text drawn centred on its own icon) is never tinted or dimmed; at night it is drawn
// as its night version: the sprite's own image with light and dark swapped (a dark box with a light edge) and a light
// number. Labels and icons beside their text still follow the night look.
// Offline: the starter's style with a fake map, no tiles.
// Run: node --test tests/basemap-signs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STARTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map', 'starter');
const { Look, applyOverrides, isSign, nightIcon, nightSignImage, NIGHT_SIGN } = await import(pathToFileURL(path.join(STARTER, 'engine', 'look.js')).href);
const { handleMissing } = await import(pathToFileURL(path.join(STARTER, 'engine', 'layers.js')).href);
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
    setLayoutProperty: (id, prop, v) => set.push({ id, prop, v, layout: true }),
  };
}
const SHIELDS = ['highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us'];

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

test('at night a road shield is its night version with a light number; never dimmed or tinted; by day the sprite as it is', () => {
  const map = fakeMap(style.layers);
  const look = new Look(map, new Set());
  const byLayer = (id) => Object.fromEntries(map.set.filter((x) => x.id === id).map((x) => [x.prop, x.v]));
  // day, and dusk before the labels flip: nothing on a shield changes
  look.apply(0, 0); look.apply(0.4, 0.8);
  assert.ok(!map.set.some((x) => SHIELDS.includes(x.id)), JSON.stringify(map.set.filter((x) => SHIELDS.includes(x.id))));
  look.apply(1, 0);
  for (const id of SHIELDS) {
    const l = style.layers.find((x) => x.id === id);
    assert.deepEqual(byLayer(id), { 'icon-image': ['concat', NIGHT_SIGN, l.layout['icon-image']], 'text-color': '#d3dbe8' },
      `${id}: the night version of its own icon and a light number, nothing dimmed`);
  }
  // a place's label turns light at night and its icon dims, as before
  const poi = map.set.filter((x) => x.id === 'poi_r1').map((x) => x.prop);
  assert.ok(poi.includes('text-color') && poi.includes('icon-opacity'), poi.join(', '));
  // back to day: the sprite's own icon and the style's own number colour
  map.set.length = 0;
  look.apply(0, 0);
  for (const id of SHIELDS) {
    const l = style.layers.find((x) => x.id === id);
    assert.deepEqual(byLayer(id), { 'icon-image': l.layout['icon-image'], 'text-color': undefined }, id);
  }
});

// The day / night look never overwrites a property an override set (reference/config.md): a sign whose number colour
// the site chose keeps the sprite's own image and that colour at night, as it did before signs had a night version.
test('a sign whose number colour an override set is left as the site styled it at night; other signs still switch', () => {
  const map = fakeMap(style.layers);
  const owned = applyOverrides(map, [{ layers: 'highway-shield-non-us', color: '#222222' }]);
  assert.ok(owned.has('highway-shield-non-us|text-color'), [...owned].join(', '));
  map.set.length = 0;
  const look = new Look(map, owned);
  look.apply(1, 0);
  assert.deepEqual(map.set.filter((x) => x.id === 'highway-shield-non-us'), [], 'neither its icon nor its number colour changes');
  assert.ok(map.set.some((x) => x.id === 'road_shield_us' && x.prop === 'icon-image'), 'a sign the site left alone still gets its night version');
  map.set.length = 0;
  look.apply(0, 0);
  assert.deepEqual(map.set.filter((x) => x.id === 'highway-shield-non-us'), [], 'nor by day');
});

test('nightIcon: the same image under the night prefix, tokens kept', () => {
  assert.equal(nightIcon('road_{ref_length}'), 'uw:night:road_{ref_length}');
  assert.equal(nightIcon('uw:night:road_2'), 'uw:night:road_2');
  assert.deepEqual(nightIcon(['get', 'shield']), ['concat', 'uw:night:', ['get', 'shield']]);
  assert.equal(nightIcon({ stops: [] }), null, 'a legacy function is left as it is');
});

// a 3×1 sign: a white box pixel, its dark grey edge, a blue shield pixel (half transparent)
const SPRITE = { width: 3, height: 1, data: new Uint8Array([255, 255, 255, 255, 74, 74, 74, 255, 40, 80, 200, 128]) };
const lum = (d, i) => (Math.max(d[i], d[i + 1], d[i + 2]) + Math.min(d[i], d[i + 1], d[i + 2])) / 2;

test('nightSignImage: light and dark swap, hue and alpha stay', () => {
  const n = nightSignImage(SPRITE);
  assert.equal(n.width, 3); assert.equal(n.height, 1);
  assert.ok(lum(n.data, 0) < 60, `the white box goes dark (${[...n.data.slice(0, 4)]})`);
  assert.ok(lum(n.data, 4) > 150, `its dark edge goes light (${[...n.data.slice(4, 8)]})`);
  assert.ok(lum(n.data, 4) - lum(n.data, 0) > 100, 'the edge stands out from the box');
  const [r, g, b, a] = n.data.slice(8, 12);
  assert.ok(b > g && g > r, `still blue (${r},${g},${b})`);
  assert.equal(a, 128);
  assert.equal(n.data[3], 255); assert.equal(n.data[7], 255);
  assert.deepEqual([...SPRITE.data.slice(0, 4)], [255, 255, 255, 255], 'the sprite itself is untouched');
});

test('handleMissing draws a night sign from the sprite image the first time a tile asks for it', () => {
  const added = new Map();
  const images = { road_2: { data: SPRITE, pixelRatio: 2, sdf: false, content: [1, 0, 2, 1] }, ring: { data: SPRITE, pixelRatio: 1, sdf: true } };
  const map = { hasImage: (id) => added.has(id), getImage: (id) => images[id] || null, addImage: (id, img, o) => added.set(id, { img, o }) };
  handleMissing(map, 'uw:night:road_2');
  const n = added.get('uw:night:road_2');
  assert.ok(n, 'added');
  assert.deepEqual([...n.img.data], [...nightSignImage(SPRITE).data]);
  assert.equal(n.o.pixelRatio, 2); assert.equal(n.o.sdf, false); assert.deepEqual(n.o.content, [1, 0, 2, 1]);
  // a sprite without that image: nothing drawn (as any sprite gap), never an error
  handleMissing(map, 'uw:night:road_9');
  assert.deepEqual([...added.get('uw:night:road_9').img.data], [0, 0, 0, 0]);
  // an SDF icon takes its colour from the layer: its pixels stay
  handleMissing(map, 'uw:night:ring');
  assert.deepEqual([...added.get('uw:night:ring').img.data], [...SPRITE.data]);
  assert.equal(added.get('uw:night:ring').o.sdf, true);
});
