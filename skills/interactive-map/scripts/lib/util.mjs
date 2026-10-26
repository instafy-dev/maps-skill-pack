// Shared helpers: argument parsing, output, file IO, geometry. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';

export class UsageError extends Error {
  constructor(msg) { super(msg); this.name = 'UsageError'; this.exitCode = 2; }
}
export class UserError extends Error {
  constructor(msg, exitCode = 1) { super(msg); this.name = 'UserError'; this.exitCode = exitCode; }
}
/** exit 4 with one "skipped: …" line: a step that cannot run yet (its input was skipped); the map stays valid */
export function skipped(line) {
  const e = new UserError(line, 4);
  e.name = 'SkipError'; e.line = line.startsWith('skipped:') ? line : `skipped: ${line}`;
  return e;
}

// ---------------------------------------------------------------------------
// Arguments
// spec: { flagName: 'string' | 'number' | 'bool' | 'multi' }
// Global flags (--json, --help) are always accepted.
export function parseArgs(argv, spec, { positionals = [0, 1], command = '' } = {}) {
  const out = { _: [] };
  const all = { json: 'bool', help: 'bool', ...spec };
  for (const [k, t] of Object.entries(all)) if (t === 'multi') out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) {
      let name = a.slice(2); let val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      const type = all[name];
      if (!type) {
        const known = Object.keys(all).map((k) => '--' + k).join(' ');
        throw new UsageError(`unknown flag --${name}${command ? ` for "${command}"` : ''}. Known flags: ${known}`);
      }
      if (type === 'bool') {
        if (val !== undefined) out[name] = !/^(0|false|no)$/i.test(val); else out[name] = true;
        continue;
      }
      if (val === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`flag --${name} needs a value`);
        // Never swallow the next flag as a value: `--names --json` must not turn --json into the value.
        const next = argv[i + 1];
        if (next.startsWith('--') && all[next.slice(2).split('=')[0]]) throw new UsageError(`flag --${name} needs a value, got the flag ${next}`);
        val = argv[++i];
      }
      if (type === 'number') {
        const n = Number(val);
        if (!Number.isFinite(n)) throw new UsageError(`flag --${name} expects a number, got "${val}"`);
        out[name] = n;
      } else if (type === 'multi') out[name].push(val);
      else out[name] = val;
      continue;
    }
    out._.push(a);
  }
  const [min, max] = positionals;
  if (!out.help) {
    if (out._.length < min) throw new UsageError(`"${command}" needs ${min} positional argument(s), got ${out._.length}`);
    if (out._.length > max) throw new UsageError(`"${command}" got unexpected argument(s): ${out._.slice(max).join(' ')}`);
  }
  return out;
}

export function need(args, name, hint = '') {
  if (args[name] === undefined || args[name] === '' || (Array.isArray(args[name]) && !args[name].length))
    throw new UsageError(`missing required flag --${name}${hint ? ` (${hint})` : ''}`);
  return args[name];
}

// ---------------------------------------------------------------------------
// Output
export function makeOut(args) {
  const json = !!args.json;
  return {
    json,
    log: (...m) => { if (!json) console.log(...m); },
    warn: (...m) => { console.error('warning:', ...m); },
    result: (obj, lines) => {
      if (json) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
      else for (const l of [].concat(lines || [])) if (l != null) console.log(l);
    },
  };
}

// ---------------------------------------------------------------------------
// Files
export function readJSON(file) {
  const txt = fs.readFileSync(file, 'utf8');
  return JSON.parse(txt);
}
export function readJSONSafe(file) {
  try { return { value: readJSON(file) }; } catch (e) { return { error: e }; }
}
export function writeJSON(file, obj, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, (pretty ? prettyJSON(obj) : JSON.stringify(obj)) + '\n');
  fs.renameSync(tmp, file);
  return fs.statSync(file).size;
}
// GeoJSON: one feature per line keeps diffs readable and files compact.
export function writeGeoJSON(file, fc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parts = ['{"type":"FeatureCollection"'];
  for (const [k, v] of Object.entries(fc)) if (k !== 'type' && k !== 'features') parts.push(`,${JSON.stringify(k)}:${JSON.stringify(v)}`);
  parts.push(',"features":[\n');
  const feats = fc.features.map((f) => JSON.stringify(f));
  const body = parts.join('') + feats.join(',\n') + '\n]}\n';
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return Buffer.byteLength(body);
}
export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------------------------------------------------------------------------
// Parsing helpers
export function parseLngLat(s, flag = 'point') {
  if (Array.isArray(s)) s = s.join(',');
  const m = String(s).trim().split(/\s*,\s*/).map(Number);
  if (m.length !== 2 || m.some((n) => !Number.isFinite(n)))
    throw new UsageError(`--${flag} expects "lng,lat" (e.g. 121.52,25.05), got "${s}"`);
  const [lng, lat] = m;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new UsageError(`--${flag} "${s}" is out of range; the order is lng,lat (longitude first)`);
  if (lng === 0 && lat === 0) throw new UsageError(`--${flag} is [0,0], which is almost certainly a missing coordinate`);
  return [lng, lat];
}
export function parseBBox(s, flag = 'bbox') {
  const m = String(s).trim().split(/\s*,\s*/).map(Number);
  if (m.length !== 4 || m.some((n) => !Number.isFinite(n)))
    throw new UsageError(`--${flag} expects "west,south,east,north" (e.g. 121.515,25.045,121.535,25.060), got "${s}"`);
  const [w, s2, e, n] = m;
  if (w >= e || s2 >= n) throw new UsageError(`--${flag} "${s}" must be west<east and south<north (order: w,s,e,n)`);
  if (Math.abs(s2) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180) throw new UsageError(`--${flag} "${s}" out of range`);
  return [w, s2, e, n];
}
export function parseList(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}
// "1h45", "45m", "2h", "90" (minutes) -> minutes
export function parseDuration(s) {
  s = String(s).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/i))) return Math.round(Number(m[1]) * 60 + Number(m[2] || 0));
  if ((m = s.match(/^(\d+)\s*(?:m|min)$/i))) return Number(m[1]);
  if ((m = s.match(/^(\d+):(\d{2})$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^\d+$/))) return Number(s);
  return null;
}
export function fmtMinutes(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (!h) return `${m} min`;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}
/** At most `max` characters, cut after a whole word with "…" (never "…near the airp"). Whitespace is collapsed. */
export function clipWords(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const at = cut.lastIndexOf(' ');
  return `${(at >= max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s.,;:·–-]+$/, '')}…`;
}
export function slugify(s) {
  const base = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base;
}

// ---------------------------------------------------------------------------
// Geometry
export const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
export function round6(n) { return Math.round(n * 1e6) / 1e6; }
export function roundCoords(c) {
  if (typeof c[0] === 'number') return c.map(round6);
  return c.map(roundCoords);
}
export function haversine(a, b) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function bboxAreaKm2([w, s, e, n]) {
  const h = rad(n - s) * R;
  const wd = rad(e - w) * R * Math.cos(rad((s + n) / 2));
  return (h * wd) / 1e6;
}
export function bboxAround([lng, lat], radiusM) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.max(0.01, Math.cos(rad(lat))));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}
// Local equirectangular projection (metres) around a reference latitude.
export function projector(lat0) {
  const kx = 111320 * Math.cos(rad(lat0)), ky = 110574;
  return { x: (lng) => lng * kx, y: (lat) => lat * ky, kx, ky };
}
// Douglas-Peucker on [lng,lat] coords with tolerance in metres.
export function simplifyLine(coords, tolM) {
  if (!tolM || coords.length < 3) return coords;
  const lat0 = coords[0][1];
  const P = projector(lat0);
  const pts = coords.map((c) => [c[0] * P.kx, c[1] * P.ky]);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  const tol2 = tolM * tolM;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}
// Ray casting; ring = [[lng,lat],...]
export function pointInRing(pt, ring) {
  const [x, y] = pt; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInPolygonGeom(pt, geom) {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const poly of polys) {
    if (!poly.length || !pointInRing(pt, poly[0])) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (pointInRing(pt, poly[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
// Representative point of any geometry (points: itself; lines: middle vertex; polygons: bbox centre).
export function representativePoint(geom) {
  if (!geom) return null;
  switch (geom.type) {
    case 'Point': return geom.coordinates;
    case 'MultiPoint': return geom.coordinates[0];
    case 'LineString': return geom.coordinates[Math.floor(geom.coordinates.length / 2)];
    case 'MultiLineString': return geom.coordinates[0][Math.floor(geom.coordinates[0].length / 2)];
    case 'Polygon': case 'MultiPolygon': {
      const b = geomBBox(geom); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    }
    default: return null;
  }
}
export function geomBBox(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; }
    else c.forEach(walk);
  };
  if (geom.type === 'GeometryCollection') geom.geometries.forEach((g) => walk(g.coordinates));
  else walk(geom.coordinates);
  return [w, s, e, n];
}
export function lineLengthM(coords) {
  let d = 0; for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]); return d;
}

// Small concurrency-free sleep
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Merge line parts that share endpoints into longer lines (greedy, endpoint-indexed).
export function mergeLines(parts) {
  const key = (c) => c[0].toFixed(7) + ',' + c[1].toFixed(7);
  const lines = parts.filter((p) => p && p.length >= 2).map((p) => p.slice());
  const used = new Uint8Array(lines.length);
  const ends = new Map();
  const add = (k, i) => { let a = ends.get(k); if (!a) ends.set(k, (a = [])); a.push(i); };
  lines.forEach((l, i) => { add(key(l[0]), i); add(key(l[l.length - 1]), i); });
  const take = (k, self) => {
    const a = ends.get(k);
    if (!a) return -1;
    for (const i of a) if (!used[i] && i !== self) return i;
    return -1;
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let cur = lines[i];
    for (;;) { // extend at the end
      const j = take(key(cur[cur.length - 1]), i);
      if (j < 0) break;
      used[j] = 1;
      const l = lines[j];
      cur = key(l[0]) === key(cur[cur.length - 1]) ? cur.concat(l.slice(1)) : cur.concat(l.slice(0, -1).reverse());
    }
    for (;;) { // extend at the start
      const j = take(key(cur[0]), i);
      if (j < 0) break;
      used[j] = 1;
      const l = lines[j];
      cur = key(l[l.length - 1]) === key(cur[0]) ? l.slice(0, -1).concat(cur) : l.slice(1).reverse().concat(cur);
    }
    out.push(cur);
  }
  return out;
}

// Assemble closed rings from way geometries (multipolygon members). Unclosable chains are dropped.
export function assembleRings(parts) {
  const merged = mergeLines(parts);
  const rings = [];
  for (const l of merged) {
    const a = l[0], b = l[l.length - 1];
    if (l.length >= 4 && a[0] === b[0] && a[1] === b[1]) rings.push(l);
    else if (l.length >= 3 && haversine(a, b) < 50) rings.push(l.concat([a])); // nearly closed (clipped data)
  }
  return rings;
}

// Human-friendly JSON: 2-space indent, but short arrays/objects (coordinates, small style objects) on one line.
export function prettyJSON(v, level = 0) {
  const pad = '  '.repeat(level), pad1 = '  '.repeat(level + 1);
  const inline = JSON.stringify(v);
  if (v === null || typeof v !== 'object') return inline;
  const flat = (x) => x === null || typeof x !== 'object' || (Array.isArray(x) && x.every((y) => y === null || typeof y !== 'object'));
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(flat) && inline.length <= 100) return inline.replace(/,(?=\S)/g, ', ');
    return '[\n' + v.map((x) => pad1 + prettyJSON(x, level + 1)).join(',\n') + '\n' + pad + ']';
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  if (inline.length <= 72 && Object.values(v).every(flat)) return '{ ' + keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(v[k]).replace(/,(?=\S)/g, ', ')}`).join(', ') + ' }';
  return '{\n' + keys.map((k) => `${pad1}${JSON.stringify(k)}: ${prettyJSON(v[k], level + 1)}`).join(',\n') + '\n' + pad + '}';
}
