// Geometry helpers for v0.2 commands: bearings, point-on-line, raster → smoothed polygons, polylabel, line buffers.
// Zero dependencies. Coordinates are [lng, lat]; metric work happens in a local equirectangular projection.
import { haversine, projector, simplifyLine, round6 } from './util.mjs';

const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;

// Initial great-circle bearing a → b, 0-359 (integer).
export function bearing(a, b) {
  const φ1 = rad(a[1]), φ2 = rad(b[1]), Δλ = rad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.round((deg(Math.atan2(y, x)) + 360) % 360) % 360;
}
// Normalise an angle difference to [-180, 180).
export function normAngle(a) { let x = ((a + 180) % 360 + 360) % 360 - 180; if (x === 180) x = -180; return x; }

// Nearest point on a polyline (coords [[lng,lat],…]) to pt. Returns { point, dist_m, index, t }.
export function nearestOnLine(pt, coords) {
  const P = projector(pt[1]);
  const px = pt[0] * P.kx, py = pt[1] * P.ky;
  let best = null;
  for (let i = 0; i + 1 < coords.length; i++) {
    const ax = coords[i][0] * P.kx, ay = coords[i][1] * P.ky, bx = coords[i + 1][0] * P.kx, by = coords[i + 1][1] * P.ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const d = Math.hypot(qx - px, qy - py);
    if (!best || d < best.dist_m) best = { point: [qx / P.kx, qy / P.ky], dist_m: d, index: i, t };
  }
  if (!best && coords.length === 1) best = { point: coords[0], dist_m: haversine(pt, coords[0]), index: 0, t: 0 };
  return best;
}

// Length of the parts of a polyline whose segment midpoints fall inside a test function.
export function lengthInside(coords, inside) {
  let d = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const m = [(coords[i][0] + coords[i + 1][0]) / 2, (coords[i][1] + coords[i + 1][1]) / 2];
    if (inside(m)) d += haversine(coords[i], coords[i + 1]);
  }
  return d;
}

// Signed area of a ring in its own planar units (positive = counter-clockwise with y up).
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2;
}

// Chaikin corner cutting on a closed ring (first point == last point allowed).
export function chaikin(ring, iterations = 2) {
  let pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  for (let k = 0; k < iterations; k++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    pts = out;
  }
  pts.push(pts[0].slice());
  return pts;
}

function dropCollinear(ring) {
  const pts = ring.slice(0, -1);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-12) out.push(b);
  }
  out.push(out[0].slice());
  return out;
}

// Trace the boundaries of a binary raster (mask[y*w+x] truthy = inside; y grows upward) into closed rings in raster
// coordinates (pixel corners). Outer rings are counter-clockwise, holes clockwise.
export function traceRaster(mask, w, h) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !!mask[y * w + x];
  const edges = new Map(); // "x,y" → list of [x2,y2]
  const add = (x1, y1, x2, y2) => { const k = x1 + ',' + y1; let a = edges.get(k); if (!a) edges.set(k, (a = [])); a.push([x2, y2]); };
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!at(x, y)) continue;
    // inside on the left when walking the edge
    if (!at(x, y - 1)) { add(x, y, x + 1, y); n++; }        // bottom: → east
    if (!at(x + 1, y)) { add(x + 1, y, x + 1, y + 1); n++; } // right: ↑ north
    if (!at(x, y + 1)) { add(x + 1, y + 1, x, y + 1); n++; } // top: ← west
    if (!at(x - 1, y)) { add(x, y + 1, x, y); n++; }        // left: ↓ south
  }
  const rings = [];
  for (;;) {
    let startKey = null;
    for (const [k, a] of edges) if (a.length) { startKey = k; break; }
    if (startKey === null) break;
    const [sx, sy] = startKey.split(',').map(Number);
    const ring = [[sx, sy]];
    let cx = sx, cy = sy, px = null, py = null;
    for (let guard = 0; guard <= n + 2; guard++) {
      const list = edges.get(cx + ',' + cy);
      if (!list || !list.length) break;
      let idx = 0;
      if (list.length > 1 && px !== null) {
        // saddle: take the sharpest left turn (keeps diagonal-touching pixels apart)
        const dx0 = cx - px, dy0 = cy - py;
        let bestScore = -Infinity;
        list.forEach(([nx, ny], i) => {
          const dx1 = nx - cx, dy1 = ny - cy;
          const cross = dx0 * dy1 - dy0 * dx1, dot = dx0 * dx1 + dy0 * dy1;
          const score = cross > 0 ? 2 : dot > 0 ? 1 : 0;
          if (score > bestScore) { bestScore = score; idx = i; }
        });
      }
      const [nx, ny] = list.splice(idx, 1)[0];
      px = cx; py = cy; cx = nx; cy = ny;
      ring.push([cx, cy]);
      if (cx === sx && cy === sy) break;
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// Polygon (in cell units: x = col, y = row, a cell spans [c, c+1]) covering a set of grid cells.
// Steps: fill holes of ≤ maxHole cells, upsample ×4, dilate by `buffer` cells, trace, smooth with Chaikin.
// Returns { outer: ring, holes: [ring] } in cell units, or null.
export function cellsToPolygon(cells, { maxHole = 2, buffer = 0.25, smooth = 2 } = {}) {
  if (!cells.length) return null;
  let c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (const [c, r] of cells) { c0 = Math.min(c0, c); r0 = Math.min(r0, r); c1 = Math.max(c1, c); r1 = Math.max(r1, r); }
  const pad = 2, W = c1 - c0 + 1 + 2 * pad, H = r1 - r0 + 1 + 2 * pad;
  const grid = new Uint8Array(W * H);
  for (const [c, r] of cells) grid[(r - r0 + pad) * W + (c - c0 + pad)] = 1;
  // holes: 4-connected empty regions not reachable from the border
  const seen = new Uint8Array(W * H);
  const flood = (start) => {
    const stack = [start], comp = [];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop(); comp.push(i);
      const x = i % W, y = (i - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!seen[j] && !grid[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    return comp;
  };
  flood(0);
  for (let i = 0; i < W * H; i++) if (!grid[i] && !seen[i]) { const comp = flood(i); if (comp.length <= maxHole) for (const j of comp) grid[j] = 1; }
  // upsample + dilate
  const S = 4, d = Math.max(0, Math.round(buffer * S));
  const w = W * S, h = H * S;
  const up = new Uint8Array(w * h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid[y * W + x])
    for (let yy = y * S - d; yy < (y + 1) * S + d; yy++) for (let xx = x * S - d; xx < (x + 1) * S + d; xx++)
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) up[yy * w + xx] = 1;
  const rings = traceRaster(up, w, h).map(dropCollinear)
    .map((ring) => ring.map(([x, y]) => [x / S - pad + c0, y / S - pad + r0]));
  if (!rings.length) return null;
  const outers = rings.filter((r) => ringArea(r) > 0).sort((a, b) => ringArea(b) - ringArea(a));
  if (!outers.length) return null;
  const outer = smooth ? chaikin(outers[0], smooth) : outers[0];
  const holes = rings.filter((r) => ringArea(r) < 0).map((r) => (smooth ? chaikin(r, smooth) : r));
  return { outer, holes };
}

// Pole of inaccessibility (polylabel, Mapbox's algorithm) for a polygon [outer, ...holes] of [lng,lat] rings.
export function polylabel(rings, precisionM = 5) {
  const lat0 = rings[0][0][1], P = projector(lat0);
  const poly = rings.map((r) => r.map(([x, y]) => [x * P.kx, y * P.ky]));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly[0]) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const width = maxX - minX, height = maxY - minY, cellSize = Math.min(width, height);
  const back = ([x, y]) => [round6(x / P.kx), round6(y / P.ky)];
  if (cellSize === 0) return back([minX, minY]);
  const dist = (x, y) => {
    let inside = false, minD = Infinity;
    for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      let px = a[0], py = a[1], dx = b[0] - px, dy = b[1] - py;
      if (dx || dy) { const t = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy))); px += dx * t; py += dy * t; }
      minD = Math.min(minD, (x - px) ** 2 + (y - py) ** 2);
    }
    return (inside ? 1 : -1) * Math.sqrt(minD);
  };
  const cell = (x, y, h) => { const d = dist(x, y); return { x, y, h, d, max: d + h * Math.SQRT2 }; };
  const queue = [];
  let h = cellSize / 2;
  for (let x = minX; x < maxX; x += cellSize) for (let y = minY; y < maxY; y += cellSize) queue.push(cell(x + h, y + h, h));
  // centroid as the first guess
  let A = 0, cx = 0, cy = 0;
  const r0 = poly[0];
  for (let i = 0, j = r0.length - 1; i < r0.length; j = i++) { const f = r0[i][0] * r0[j][1] - r0[j][0] * r0[i][1]; cx += (r0[i][0] + r0[j][0]) * f; cy += (r0[i][1] + r0[j][1]) * f; A += f * 3; }
  let best = A ? cell(cx / A, cy / A, 0) : cell(minX + width / 2, minY + height / 2, 0);
  const bbox = cell(minX + width / 2, minY + height / 2, 0);
  if (bbox.d > best.d) best = bbox;
  let guard = 0;
  while (queue.length && guard++ < 20000) {
    queue.sort((a, b) => a.max - b.max);
    const c = queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precisionM) continue;
    h = c.h / 2;
    queue.push(cell(c.x - h, c.y - h, h), cell(c.x + h, c.y - h, h), cell(c.x - h, c.y + h, h), cell(c.x + h, c.y + h, h));
  }
  return back([best.x, best.y]);
}

// Buffer a polyline by m metres → closed ring (miter joins clamped, round caps). Good for short streets.
export function bufferLine(coords, m, capSteps = 6) {
  if (coords.length < 2) {
    const c = coords[0], P = projector(c[1]);
    const ring = [];
    for (let i = 0; i <= 16; i++) { const a = (i / 16) * 2 * Math.PI; ring.push([round6(c[0] + (m * Math.cos(a)) / P.kx), round6(c[1] + (m * Math.sin(a)) / P.ky)]); }
    return ring;
  }
  const P = projector(coords[0][1]);
  const pts = coords.map(([x, y]) => [x * P.kx, y * P.ky]);
  const norm = (i) => { const a = pts[i], b = pts[i + 1]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [-dy / L, dx / L]; };
  const side = (s) => pts.map((p, i) => {
    let n;
    if (i === 0) n = norm(0); else if (i === pts.length - 1) n = norm(i - 1);
    else { const a = norm(i - 1), b = norm(i); n = [a[0] + b[0], a[1] + b[1]]; const L = Math.hypot(n[0], n[1]) || 1; const k = Math.min(2, 1 / Math.max(0.5, (a[0] * b[0] + a[1] * b[1] + 1) / 2) ** 0.5); n = [(n[0] / L) * k, (n[1] / L) * k]; }
    return [p[0] + s * n[0] * m, p[1] + s * n[1] * m];
  });
  const left = side(1), right = side(-1).reverse();
  const cap = (center, from) => {
    const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]); const out = [];
    for (let k = 1; k < capSteps; k++) { const a = a0 - (k / capSteps) * Math.PI; out.push([center[0] + m * Math.cos(a), center[1] + m * Math.sin(a)]); }
    return out;
  };
  const ring = [...left, ...cap(pts[pts.length - 1], left[left.length - 1]), ...right, ...cap(pts[0], right[right.length - 1])];
  ring.push(ring[0]);
  return ring.map(([x, y]) => [round6(x / P.kx), round6(y / P.ky)]);
}

// Douglas-Peucker on a closed ring (keeps it closed).
export function simplifyRing(ring, tolM) {
  const s = simplifyLine(ring, tolM);
  if (s.length < 4) return ring;
  return s;
}

// Standard NOAA solar position: sunrise and sunset (UTC ms) for a date and place. null when the sun does not rise/set.
export function sunTimes(dateMs, lat, lng) {
  const d = new Date(dateMs);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const jd = day / 864e5 + 2440587.5;
  const calc = (rising) => {
    // iterate twice for accuracy
    let t = 12 - (rising ? 6 : -6) - lng / 15;
    for (let k = 0; k < 2; k++) {
      const jc = (jd + t / 24 - 2451545) / 36525;
      const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
      const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
      const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
      const C = Math.sin(rad(M)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * jc) + Math.sin(rad(3 * M)) * 0.000289;
      const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * jc));
      const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
      const eps = eps0 + 0.00256 * Math.cos(rad(125.04 - 1934.136 * jc));
      const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
      const y = Math.tan(rad(eps / 2)) ** 2;
      const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
        - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
      const cosH = (Math.cos(rad(90.833)) - Math.sin(rad(lat)) * Math.sin(rad(decl))) / (Math.cos(rad(lat)) * Math.cos(rad(decl)));
      if (cosH > 1 || cosH < -1) return null;
      const H = deg(Math.acos(cosH));
      const minutes = 720 - 4 * (lng + (rising ? H : -H)) - eqTime;
      t = minutes / 60;
    }
    return day + t * 3600e3;
  };
  return { sunrise: calc(true), sunset: calc(false) };
}
// true when the instant lies before local sunrise or after local sunset at that place.
export function isNight(ms, lat, lng) {
  const { sunrise, sunset } = sunTimes(ms, lat, lng);
  if (sunrise == null || sunset == null) return false;
  // the UTC day may not align with the local day: check yesterday/today/tomorrow windows
  for (const off of [-864e5, 0, 864e5]) {
    const s = sunTimes(ms + off, lat, lng);
    if (s.sunrise != null && ms >= s.sunrise && ms <= s.sunset) return false;
  }
  return true;
}
