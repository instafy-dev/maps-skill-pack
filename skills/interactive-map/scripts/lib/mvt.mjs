// A small Mapbox Vector Tile (MVT 2.1) decoder: layers, feature properties and line/point/polygon geometry as
// [lng, lat]. Enough to read the basemap's own tiles (OpenMapTiles schema, e.g. OpenFreeMap) where a map pack command
// needs geometry the basemap already draws (rail track when Overpass is busy). Pure; no dependencies.
import zlib from 'node:zlib';

function reader(buf) {
  let pos = 0;
  const varint = () => {
    let result = 0, shift = 0, b;
    do {
      if (pos >= buf.length) throw new Error('vector tile: truncated varint');
      b = buf[pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  };
  return {
    get pos() { return pos; },
    eof: () => pos >= buf.length,
    varint,
    bytes() { const len = varint(); const out = buf.subarray(pos, pos + len); pos += len; return out; },
    skip(wire) {
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) { const len = varint(); pos += len; }
      else if (wire === 5) pos += 4;
      else throw new Error(`vector tile: unknown wire type ${wire}`);
    },
    double() { const v = buf.readDoubleLE(pos); pos += 8; return v; },
    float() { const v = buf.readFloatLE(pos); pos += 4; return v; },
  };
}

const zigzag = (n) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);
const packed = (bytes) => { const r = reader(bytes); const out = []; while (!r.eof()) out.push(r.varint()); return out; };

function readValue(bytes) {
  const r = reader(bytes);
  let v = null;
  while (!r.eof()) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1) v = r.bytes().toString('utf8');
    else if (field === 2) v = r.float();
    else if (field === 3) v = r.double();
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = zigzag(r.varint());
    else if (field === 7) v = !!r.varint();
    else r.skip(wire);
  }
  return v;
}

/** Tile pixel (x, y in 0..extent) of tile z/x/y → [lng, lat]. */
function toLngLat(px, py, extent, z, tx, ty) {
  const n = 2 ** z;
  const lng = ((tx + px / extent) / n) * 360 - 180;
  const yMerc = Math.PI * (1 - (2 * (ty + py / extent)) / n);
  const lat = (Math.atan(Math.sinh(yMerc)) * 180) / Math.PI;
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

function decodeGeometry(cmds, type, extent, z, x, y) {
  const parts = [];
  let cur = null, px = 0, py = 0;
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++], id = c & 7, count = c >> 3;
    if (id === 7) { if (cur && cur.length) cur.push(cur[0]); continue; }
    for (let k = 0; k < count; k++) {
      px += zigzag(cmds[i++]); py += zigzag(cmds[i++]);
      if (id === 1) { cur = []; parts.push(cur); }
      cur?.push(toLngLat(px, py, extent, z, x, y));
    }
  }
  return { type: type === 1 ? 'Point' : type === 2 ? 'Line' : type === 3 ? 'Polygon' : 'Unknown', parts };
}

/** Decode a tile (gzip or raw). `only`: the layer names to keep (others are skipped undecoded). Returns
 *  { [layer]: [{ id, properties, type, parts: [[lng,lat]…] }] }. */
export function decodeTile(input, { z, x, y, only = null } = {}) {
  let buf = Buffer.from(input);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const r = reader(buf);
  const out = {};
  while (!r.eof()) {
    const tag = r.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { r.skip(tag & 7); continue; }
    const lr = reader(r.bytes());
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (!lr.eof()) {
      const t = lr.varint(), f = t >> 3, wire = t & 7;
      if (f === 1) name = lr.bytes().toString('utf8');
      else if (f === 2) feats.push(lr.bytes());
      else if (f === 3) keys.push(lr.bytes().toString('utf8'));
      else if (f === 4) values.push(readValue(lr.bytes()));
      else if (f === 5) extent = lr.varint();
      else lr.skip(wire);
    }
    if (only && !only.includes(name)) continue;
    const list = (out[name] ||= []);
    for (const fb of feats) {
      const fr = reader(fb);
      let id = null, tags = [], type = 0, geom = [];
      while (!fr.eof()) {
        const t = fr.varint(), f = t >> 3, wire = t & 7;
        if (f === 1) id = fr.varint();
        else if (f === 2) tags = packed(fr.bytes());
        else if (f === 3) type = fr.varint();
        else if (f === 4) geom = packed(fr.bytes());
        else fr.skip(wire);
      }
      const properties = {};
      for (let i = 0; i + 1 < tags.length; i += 2) properties[keys[tags[i]]] = values[tags[i + 1]];
      list.push({ id, properties, ...decodeGeometry(geom, type, extent, z, x, y) });
    }
  }
  return out;
}

/** The z/x/y tiles that cover a bbox [w, s, e, n]. */
export function tileRange(bbox, z) {
  const n = 2 ** z;
  const tx = (lng) => Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
  const ty = (lat) => {
    const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  const out = [];
  for (let x = tx(bbox[0]); x <= tx(bbox[2]); x++) for (let y = ty(bbox[3]); y <= ty(bbox[1]); y++) out.push([z, x, y]);
  return out;
}

/** Encode helpers for tests: a tile with one layer of line features ({ properties, coords: [[px,py]…] } in tile
 *  pixels). Exported so tests can serve a real binary tile. */
export function encodeLineTile(layerName, features, extent = 4096) {
  const varint = (n) => { const b = []; while (n > 127) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n); return Buffer.from(b); };
  const field = (f, wire, payload) => Buffer.concat([varint((f << 3) | wire), ...(wire === 2 ? [varint(payload.length), payload] : [varint(payload)])]);
  const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
  const keys = [], values = [];
  const idx = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { arr.push(v); i = arr.length - 1; } return i; };
  const featBufs = features.map((f, fi) => {
    const tags = [];
    for (const [k, v] of Object.entries(f.properties)) tags.push(idx(keys, k), idx(values, String(v)));
    const g = [];
    let px = 0, py = 0;
    f.coords.forEach(([x, y], i) => {
      if (i === 0) g.push((1 & 7) | (1 << 3));
      if (i === 1) g.push((2 & 7) | ((f.coords.length - 1) << 3));
      g.push(zz(x - px), zz(y - py)); px = x; py = y;
    });
    return Buffer.concat([field(1, 0, fi + 1), field(2, 2, Buffer.concat(tags.map(varint))), field(3, 0, 2), field(4, 2, Buffer.concat(g.map(varint)))]);
  });
  const layer = Buffer.concat([field(15, 0, 2), field(1, 2, Buffer.from(layerName)), ...featBufs.map((b) => field(2, 2, b)),
    ...keys.map((k) => field(3, 2, Buffer.from(k))), ...values.map((v) => field(4, 2, field(1, 2, Buffer.from(v)))), field(5, 0, extent)]);
  return field(3, 2, layer);
}
