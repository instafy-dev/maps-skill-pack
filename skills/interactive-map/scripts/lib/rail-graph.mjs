// Shortest path along the lines of a `uw lines` layer (rail, HSR, ferry…), so a trip leg follows the real track instead
// of a straight line over the mountains. Lines from OpenStreetMap are simplified and split, so junctions do not always
// share a vertex: vertices closer than SNAP_M are one node, and a line end within JOIN_M of another line is joined to
// it (a small gap left by simplification, at a cost). No path, or one far longer than the straight line, = no track
// (the caller keeps its arc and says so).
import { haversine, round6 } from './util.mjs';

const SNAP_M = 60, JOIN_M = 450, MAX_ATTACH_M = 2500, MAX_RATIO = 3.5;

class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

/** Build a graph from a FeatureCollection of (Multi)LineStrings. */
export function buildGraph(fc, { snapM = SNAP_M, joinM = JOIN_M, filter = null } = {}) {
  const coords = [], adj = [], grid = new Map(), lineOf = [];
  const cell = 0.01; // ~1 km grid for neighbour lookups
  const ck = (c) => `${Math.floor(c[0] / cell)},${Math.floor(c[1] / cell)}`;
  const near = (c, m) => {
    const out = [];
    const [gx, gy] = [Math.floor(c[0] / cell), Math.floor(c[1] / cell)];
    const r = Math.max(1, Math.ceil(m / 900));
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (const i of grid.get(`${gx + dx},${gy + dy}`) || []) { const d = haversine(c, coords[i]); if (d <= m) out.push([i, d]); }
    return out.sort((a, b) => a[1] - b[1]);
  };
  const addNode = (c, line) => {
    const i = coords.length; coords.push(c); adj.push([]); lineOf.push(new Set([line]));
    const k = ck(c); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    return i;
  };
  const node = (c, line) => {
    const hit = near(c, snapM)[0];
    if (hit) { lineOf[hit[0]].add(line); return hit[0]; }
    return addNode(c, line);
  };
  const edges = []; // [a, b, line]
  const edge = (a, b, w, line = -1) => { if (a === b || adj[a].some(([x]) => x === b)) return; adj[a].push([b, w]); adj[b].push([a, w]); if (line >= 0) edges.push([a, b, line]); };
  const unlink = (a, b) => { adj[a] = adj[a].filter(([x]) => x !== b); adj[b] = adj[b].filter(([x]) => x !== a); };
  const ends = [];
  let line = 0;
  for (const f of fc?.features || []) {
    if (filter && !filter(f)) continue;
    const g = f?.geometry; if (!g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const ln of parts) {
      if (!Array.isArray(ln) || ln.length < 2) continue;
      let prev = node(ln[0], line); const first = prev;
      for (let j = 1; j < ln.length; j++) { const n = node(ln[j], line); edge(prev, n, haversine(coords[prev], coords[n]), line); prev = n; }
      ends.push([first, line], [prev, line]);
      line++;
    }
  }
  // Join each line end to the closest point on another line within joinM: simplified OSM lines meet at T-junctions
  // and at stations without sharing a vertex (the South-Link ends at Fangliao beside the Pingtung line). The point is
  // inserted into that segment, so the path follows the real line from there.
  const kx0 = 111320, ky = 110574;
  for (const [e, ln] of ends) {
    const pe = coords[e];
    const kx = kx0 * Math.cos((pe[1] * Math.PI) / 180);
    let best = null;
    for (let q = 0; q < edges.length; q++) {
      const [a, b, l2] = edges[q];
      if (l2 === ln || a === e || b === e) continue;
      const A = coords[a], B = coords[b];
      // cheap reject by bounding box
      const minx = Math.min(A[0], B[0]), maxx = Math.max(A[0], B[0]), miny = Math.min(A[1], B[1]), maxy = Math.max(A[1], B[1]);
      const pad = joinM / ky;
      if (pe[0] < minx - pad * 1.2 || pe[0] > maxx + pad * 1.2 || pe[1] < miny - pad || pe[1] > maxy + pad) continue;
      const ax = (A[0] - pe[0]) * kx, ay = (A[1] - pe[1]) * ky, bx = (B[0] - pe[0]) * kx, by = (B[1] - pe[1]) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
      if (d <= joinM && (!best || d < best.d)) best = { d, q, t, c: [pe[0] + px / kx, pe[1] + py / ky] };
    }
    if (!best) continue;
    const [a, b, l2] = edges[best.q];
    let target;
    if (haversine(best.c, coords[a]) <= snapM) target = a;
    else if (haversine(best.c, coords[b]) <= snapM) target = b;
    else {
      target = addNode(best.c, l2);
      unlink(a, b);
      edges[best.q] = [a, target, l2];
      edge(a, target, haversine(coords[a], best.c)); edge(target, b, haversine(best.c, coords[b]));
      edges.push([target, b, l2]);
    }
    if (target !== e) edge(e, target, best.d * 1.5);
  }
  return { coords, adj, near };
}

/** Track path between two points: { coords, km } or null (no connected track near both ends). */
export function trackPath(g, a, b, { maxAttachM = MAX_ATTACH_M, maxRatio = MAX_RATIO } = {}) {
  const sa = g.near(a, maxAttachM).slice(0, 4), sb = g.near(b, maxAttachM).slice(0, 4);
  if (!sa.length || !sb.length) return null;
  const n = g.coords.length;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const h = new Heap();
  for (const [i, d] of sa) { if (d < dist[i]) { dist[i] = d; h.push([d, i]); } }
  const goal = new Map(sb.map(([i, d]) => [i, d]));
  let best = Infinity, bestNode = -1;
  while (h.size) {
    const [d, u] = h.pop();
    if (d > dist[u]) continue;
    if (d >= best) break;
    if (goal.has(u) && d + goal.get(u) < best) { best = d + goal.get(u); bestNode = u; }
    for (const [v, w] of g.adj[u]) { const nd = d + w; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; h.push([nd, v]); } }
  }
  if (bestNode < 0) return null;
  const straight = haversine(a, b);
  if (straight > 2000 && best > straight * maxRatio) return null;
  const path = [];
  for (let u = bestNode; u >= 0; u = prev[u]) path.push(g.coords[u]);
  path.reverse();
  const out = [a, ...path, b].map((c) => [round6(c[0]), round6(c[1])]);
  const dedup = out.filter((c, i) => !i || c[0] !== out[i - 1][0] || c[1] !== out[i - 1][1]);
  return { coords: dedup, km: Math.round(best / 100) / 10, ratio: straight ? Math.round((best / straight) * 100) / 100 : 1 };
}
