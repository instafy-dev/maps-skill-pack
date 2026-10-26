// `feel`: estimate how an area feels (calm / lively / green / amenities) on a square grid from one Overpass pull.
// All scores are ESTIMATES derived from OpenStreetMap features; the engine labels them so.
import path from 'node:path';
import { parseArgs, makeOut, parseBBox, bboxAreaKm2, writeJSON, writeGeoJSON, assembleRings, round6, fmtBytes, UsageError, UserError } from './util.mjs';
import { overpass } from './net.mjs';
import { openSite, layerHint, registerLayer, viewBounds, configLayer, assertOwned, checkLayerId, layerBBox, loadLayer } from './site.mjs';

export const help = `feel <dir> [--bbox w,s,e,n | --around <layerId> [--radius 700] [--box]] [--cell 200] [--layer feel] [--force-large] [--timeout 90] [--json]
  One Overpass pull (major roads, above-ground rail, runways/airports, green areas, trees, POIs, nightlife) →
  data/feel.geojson (square grid) + data/feel.meta.json. Per cell, 0-1 percentiles within the area:
  calm_day, calm_night, lively_day, lively_night, green, amenities; raw counts n_cafe, n_food, n_gym, n_night, n_trees;
  estimated noise_day_db / noise_night_db. Noise is a rough model (road class, rail, airport distance; + nightlife at night).
  --around hotels: only the cells within --radius m (default 700, about a 10-min walk) of each point of layer "hotels",
  and one small Overpass box per point: options far apart cost no more than one each (faster when Overpass is busy).
  --box: one rectangle around the whole layer grown by --radius (default 800; the old behaviour; also used for
  line/area layers or more than 12 points). Without either, the config's view.bounds is used. Max 60 km² unless --force-large. --cell metres (50-1000).
  Slow when Overpass is busy: the default limit is 90 s (--timeout); past it the step is skipped (exit 4), nothing written.
  Registers in map.config.json (if absent): { "id": "feel", "type": "grid", "data": "data/feel.geojson" } and "vibe": { "enabled": true, "grid": "feel" }`;

// Road noise level at 10 m (dB, rough daytime Leq), rail likewise.
const ROAD_DB = { motorway: 80, trunk: 77, primary: 74, secondary: 70, tertiary: 66 };
const RAIL_DB = { rail: 76, narrow_gauge: 74, hsr: 78, subway: 72, light_rail: 68, monorail: 66, tram: 66 };
const BASE_DAY = 45, BASE_NIGHT = 37;

export async function run(argv) {
  const args = parseArgs(argv, { bbox: 'string', around: 'string', radius: 'number', cell: 'number', layer: 'string', 'force-large': 'bool', force: 'bool', box: 'bool' }, { positionals: [1, 1], command: 'feel' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const t0 = Date.now();
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer || 'feel');
  assertOwned(site, layer, 'feel', args.force);
  // --around <points>: cells within R of each point only (one small query box per point), unless --box
  let aroundPts = null;
  if (args.around && !args.bbox && !args.box) {
    const fc = loadLayer(site, args.around);
    const pts = fc.features.filter((f) => f?.geometry?.type === 'Point').map((f) => f.geometry.coordinates);
    if (pts.length && pts.length === fc.features.length && pts.length <= 12) aroundPts = pts;
  }
  const R = args.radius ?? (aroundPts ? 700 : 800);
  if (args.radius !== undefined && (R < 100 || R > 5000)) throw new UsageError('--radius must be 100-5000 m');
  const bbox = args.bbox ? parseBBox(args.bbox) : args.around ? layerBBox(site, args.around, R) : viewBounds(site);
  if (!bbox) throw new UsageError('give --bbox w,s,e,n or --around <layerId> (map.config.json has no view.bounds to fall back on)');
  if (aroundPts) out.log(`Within ${R} m of the ${aroundPts.length} point(s) of "${args.around}"`);
  else if (args.around) out.log(`Around layer "${args.around}" + ${R} m: ${bbox.join(',')}`);
  else if (!args.bbox) out.log(`Using view.bounds from map.config.json: ${bbox.join(',')}`);
  const km2 = aroundPts ? Math.min(bboxAreaKm2(bbox), aroundPts.length * Math.PI * (R / 1000) ** 2) : bboxAreaKm2(bbox);
  if (km2 > 60 && !args['force-large']) throw new UsageError(`area is ${km2.toFixed(1)} km² (> 60 km²). Use a smaller --bbox (the neighbourhoods you are comparing) or --force-large.`);
  const cell = args.cell ?? 200;
  if (cell < 50 || cell > 1000) throw new UsageError('--cell must be between 50 and 1000 metres');

  // --- projection (metres, local equirectangular)
  const lat0 = (bbox[1] + bbox[3]) / 2, lng0 = (bbox[0] + bbox[2]) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110574;
  const X = (lng) => (lng - lng0) * kx, Y = (lat) => (lat - lat0) * ky;
  const LNG = (x) => x / kx + lng0, LAT = (y) => y / ky + lat0;
  const grow = (b, m) => [b[0] - m / kx, b[1] - m / ky, b[2] + m / kx, b[3] + m / ky];
  const ob = (b) => `${b[1].toFixed(6)},${b[0].toFixed(6)},${b[3].toFixed(6)},${b[2].toFixed(6)}`;
  const BA = ob(grow(bbox, 4000));
  // query boxes: roads/POIs up to 400-500 m outside the cells still count (noise and liveliness reach that far)
  let Bs = [ob(grow(bbox, 500))];
  if (aroundPts) {
    const per = aroundPts.map((c) => grow([c[0], c[1], c[0], c[1]], R + 400));
    const big = grow(bbox, 400);
    if (per.reduce((a, b) => a + bboxAreaKm2(b), 0) < 0.8 * bboxAreaKm2(big)) Bs = per.map(ob);
    else Bs = [ob(big)];
  }
  const nCells = Math.ceil((X(bbox[2]) - X(bbox[0])) / cell) * Math.ceil((Y(bbox[3]) - Y(bbox[1])) / cell);
  if (nCells > 6000) throw new UsageError(`${nCells} cells is too many; raise --cell (e.g. --cell ${Math.ceil(cell * Math.sqrt(nCells / 3000) / 50) * 50})`);
  const each = (sel) => Bs.map((b) => `  ${sel}(${b});`).join('\n');

  const NM = '夜市|[Nn]ight ?[Mm]arket';
  const q = `[out:json][timeout:120];
(
${each('way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]["tunnel"!~"^(yes|building_passage|covered)$"]')}
${each('way["railway"~"^(rail|narrow_gauge|light_rail|subway|tram|monorail)$"]["tunnel"!~"^(yes|building_passage|covered)$"]["location"!~"^(underground|indoor)$"]["service"!~"^(yard|siding|spur|crossover)$"]')}
  way["aeroway"="runway"](${BA});
${each('way["leisure"~"^(park|garden|nature_reserve)$"]')}
${each('way["landuse"~"^(grass|forest|recreation_ground|cemetery|meadow|village_green)$"]')}
${each('way["natural"~"^(wood|scrub|grassland)$"]')}
${each('way["natural"="tree_row"]')}
${each('relation["type"="multipolygon"]["leisure"~"^(park|garden|nature_reserve)$"]')}
${each('relation["type"="multipolygon"]["landuse"~"^(grass|forest|recreation_ground|cemetery|meadow|village_green)$"]')}
${each('relation["type"="multipolygon"]["natural"~"^(wood|scrub|grassland)$"]')}
${each('way["natural"="water"]')}
${each('way["waterway"="riverbank"]')}
${each('way["landuse"~"^(reservoir|basin)$"]')}
${each('relation["type"="multipolygon"]["natural"="water"]')}
${each('relation["type"="multipolygon"]["waterway"="riverbank"]')}
);
out geom qt;
(
${each('node["natural"="tree"]')}
${each('nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|nightclub|biergarten|karaoke_box|marketplace|pharmacy|cinema|theatre|arts_centre|library|gym|bicycle_rental|community_centre|bank|post_office|clinic|doctors)$"]')}
${each('nwr["shop"]')}
${each('nwr["leisure"~"^(fitness_centre|sports_centre|dance)$"]')}
${each('nwr["tourism"~"^(attraction|museum|gallery|viewpoint|hotel|hostel|guest_house|artwork)$"]')}
${each(`nwr["name"~"${NM}"]`)}
  nwr["aeroway"="aerodrome"](${BA});
);
out center qt;`;
  out.log(`Querying Overpass for roads, rail, airports, green, trees and POIs (${km2.toFixed(1)} km², ${Bs.length} box${Bs.length > 1 ? 'es' : ''}, cells of ${cell} m)…`);
  const data = await overpass(q, { timeoutS: 120 });
  const tFetched = Date.now();
  const els = data.elements || [];

  // --- classify elements
  const roads = [], rails = [], runways = [], greens = [], waters = [], treeRows = [], pois = [], aerodromes = [];
  let nTrees = 0;
  for (const el of els) {
    const t = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const pts = el.geometry.filter(Boolean).map((p) => [X(p.lon), Y(p.lat)]);
      if (pts.length < 2) continue;
      const hw = t.highway?.replace(/_link$/, '');
      if (hw && ROAD_DB[hw] && (!t.amenity && !t.shop)) {
        let db = ROAD_DB[hw] - (t.highway.endsWith('_link') ? 4 : 0);
        roads.push({ pts, db, cls: hw });
        continue;
      }
      if (t.railway && RAIL_DB[t.railway] !== undefined) {
        const hsr = t.highspeed === 'yes';
        rails.push({ pts, db: hsr ? RAIL_DB.hsr : RAIL_DB[t.railway], kind: hsr ? 'hsr' : t.railway });
        continue;
      }
      if (t.aeroway === 'runway') { runways.push({ pts }); continue; }
      if (t.natural === 'tree_row') { treeRows.push(pts); continue; }
      if (isWater(t)) {
        const a = pts[0], b = pts[pts.length - 1];
        if (pts.length >= 4 && a[0] === b[0] && a[1] === b[1]) waters.push(polygon([pts], []));
        continue;
      }
      if (isGreen(t)) {
        const a = pts[0], b = pts[pts.length - 1];
        if (pts.length >= 4 && a[0] === b[0] && a[1] === b[1]) greens.push(polygon([pts], []));
        continue;
      }
    } else if (el.type === 'relation' && el.members && (isGreen(t) || isWater(t)) && !el.center) {
      const outer = [], inner = [];
      for (const m of el.members) {
        if (m.type !== 'way' || !m.geometry) continue;
        const pts = m.geometry.filter(Boolean).map((p) => [X(p.lon), Y(p.lat)]);
        if (pts.length >= 2) (m.role === 'inner' ? inner : outer).push(pts);
      }
      const o = assembleRings(outer), i = assembleRings(inner);
      if (o.length) (isWater(t) ? waters : greens).push(polygon(o, i));
      continue;
    }
    // POIs (out center)
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    if (t.natural === 'tree' && el.type === 'node') { pois.push({ x: X(lon), y: Y(lat), cat: 'tree' }); nTrees++; continue; }
    if (t.aeroway === 'aerodrome') {
      if (!/^(private|military)$/.test(t.aerodrome || t.access || '') && !/heli/i.test(t['aerodrome:type'] || '') && t.iata) aerodromes.push({ x: X(lon), y: Y(lat), name: t.name });
      continue;
    }
    const cats = poiCats(t, NM);
    if (cats.length) pois.push({ x: X(lon), y: Y(lat), cats, cat: cats[0], name: t.name });
  }
  // dedupe POIs mapped as both node and area at the same place (same name within 30 m) is not worth the cost; tolerate.

  // --- spatial index helpers
  const BUCKET = 100;
  const bkey = (ix, iy) => ix * 1e6 + iy;
  function indexLines(list, pad) {
    const m = new Map();
    list.forEach((l, li) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of l.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      l.bb = [x0, y0, x1, y1];
      for (let ix = Math.floor((x0 - pad) / BUCKET); ix <= Math.floor((x1 + pad) / BUCKET); ix++)
        for (let iy = Math.floor((y0 - pad) / BUCKET); iy <= Math.floor((y1 + pad) / BUCKET); iy++) {
          const k = bkey(ix, iy); let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(li);
        }
    });
    return (x, y) => m.get(bkey(Math.floor(x / BUCKET), Math.floor(y / BUCKET))) || [];
  }
  const roadIdx = indexLines(roads, 400), railIdx = indexLines(rails, 450);
  const poiIdx = new Map();
  for (const p of pois) { const k = bkey(Math.floor(p.x / BUCKET), Math.floor(p.y / BUCKET)); let a = poiIdx.get(k); if (!a) poiIdx.set(k, (a = [])); a.push(p); }
  function poisNear(x, y, r) {
    const res = [];
    const n = Math.ceil(r / BUCKET);
    const cx = Math.floor(x / BUCKET), cy = Math.floor(y / BUCKET);
    for (let ix = cx - n; ix <= cx + n; ix++) for (let iy = cy - n; iy <= cy + n; iy++) {
      const a = poiIdx.get(bkey(ix, iy));
      if (a) for (const p of a) { const d = Math.hypot(p.x - x, p.y - y); if (d <= r) res.push([p, d]); }
    }
    return res;
  }
  const lineDist = (l, x, y) => {
    let best = Infinity; const p = l.pts;
    for (let i = 1; i < p.length; i++) {
      const [ax, ay] = p[i - 1], [bx, by] = p[i];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let t = L ? ((x - ax) * dx + (y - ay) * dy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x, ey = ay + t * dy - y, d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const lineLevel = (db, d) => db - 10 * Math.log10(Math.max(d, 10) / 10) - 0.02 * d; // line source + urban screening
  const pointLevel = (db, d) => db - 20 * Math.log10(Math.max(d, 10) / 10) - 0.02 * d;

  function noiseAt(x, y) {
    let eDay = 10 ** (BASE_DAY / 10), eNight = 10 ** (BASE_NIGHT / 10);
    const seen = new Set();
    for (const li of roadIdx(x, y)) {
      if (seen.has(li)) continue; seen.add(li);
      const r = roads[li];
      if (x < r.bb[0] - 400 || x > r.bb[2] + 400 || y < r.bb[1] - 400 || y > r.bb[3] + 400) continue;
      const d = lineDist(r, x, y); if (d > 400) continue;
      const L = lineLevel(r.db, d);
      eDay += 10 ** (L / 10);
      eNight += 10 ** ((L - (r.db >= 74 ? 7 : 9)) / 10);
    }
    seen.clear();
    for (const li of railIdx(x, y)) {
      if (seen.has(li)) continue; seen.add(li);
      const r = rails[li];
      const d = lineDist(r, x, y); if (d > 450) continue;
      const L = lineLevel(r.db, d);
      eDay += 10 ** (L / 10);
      eNight += 10 ** ((L - (r.kind === 'subway' || r.kind === 'light_rail' || r.kind === 'monorail' ? 14 : 8)) / 10);
    }
    for (const r of runways) {
      const d = lineDist(r, x, y); if (d > 6000) continue;
      const L = 74 - 15 * Math.log10(Math.max(d, 300) / 300);
      eDay += 10 ** (L / 10); eNight += 10 ** ((L - 12) / 10);
    }
    if (!runways.length) for (const a of aerodromes) {
      const d = Math.hypot(a.x - x, a.y - y) - 800;
      const L = 70 - 15 * Math.log10(Math.max(d, 300) / 300);
      eDay += 10 ** (L / 10); eNight += 10 ** ((L - 12) / 10);
    }
    // nightlife adds to night noise
    for (const [p, d] of poisNear(x, y, 150)) {
      if (p.cats?.includes('night')) eNight += 10 ** (pointLevel(66, d) / 10);
      if (p.cats?.includes('night_market')) eNight += 10 ** (pointLevel(74, Math.max(10, d - 60)) / 10);
    }
    return [10 * Math.log10(eDay), 10 * Math.log10(eNight)];
  }

  // --- green polygons index
  function polygon(outer, inner) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of outer) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { outer, inner, bb: [x0, y0, x1, y1] };
  }
  const inRing = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // polygon lookup by 100 m bucket (green areas, water); a polygon is only indexed over the grid's own extent
  const gridB = [X(bbox[0]) - cell, Y(bbox[1]) - cell, X(bbox[2]) + cell, Y(bbox[3]) + cell];
  function polyIndex(list) {
    const idx = new Map();
    list.forEach((g, gi) => {
      const x0 = Math.max(g.bb[0], gridB[0]), x1 = Math.min(g.bb[2], gridB[2]), y0 = Math.max(g.bb[1], gridB[1]), y1 = Math.min(g.bb[3], gridB[3]);
      if (x0 > x1 || y0 > y1) return;
      for (let ix = Math.floor(x0 / BUCKET); ix <= Math.floor(x1 / BUCKET); ix++)
        for (let iy = Math.floor(y0 / BUCKET); iy <= Math.floor(y1 / BUCKET); iy++) {
          const k = bkey(ix, iy); let a = idx.get(k); if (!a) idx.set(k, (a = [])); a.push(gi);
        }
    });
    return (x, y) => {
      for (const gi of idx.get(bkey(Math.floor(x / BUCKET), Math.floor(y / BUCKET))) || []) {
        const g = list[gi];
        if (x < g.bb[0] || x > g.bb[2] || y < g.bb[1] || y > g.bb[3]) continue;
        if (g.outer.some((r) => inRing(x, y, r)) && !g.inner.some((r) => inRing(x, y, r))) return true;
      }
      return false;
    };
  }
  const isGreenAt = polyIndex(greens), isWaterAt = polyIndex(waters);

  // --- grid
  const gx0 = X(bbox[0]), gy0 = Y(bbox[1]);
  const nx = Math.ceil((X(bbox[2]) - gx0) / cell), ny = Math.ceil((Y(bbox[3]) - gy0) / cell);
  const cells = [];
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const x0 = gx0 + ix * cell, y0 = gy0 + iy * cell, cx = x0 + cell / 2, cy = y0 + cell / 2;
    const skip = aroundPts ? !aroundPts.some((p) => Math.hypot(X(p[0]) - cx, Y(p[1]) - cy) <= R + cell / 2) : false;
    cells.push({ ix, iy, x0, y0, cx, cy, skip, n_cafe: 0, n_food: 0, n_gym: 0, n_night: 0, n_trees: 0, n_shop: 0 });
  }
  const cellAt = (x, y) => {
    const ix = Math.floor((x - gx0) / cell), iy = Math.floor((y - gy0) / cell);
    return ix >= 0 && iy >= 0 && ix < nx && iy < ny ? cells[iy * nx + ix] : null;
  };
  // raw counts inside each cell
  for (const p of pois) {
    const c = cellAt(p.x, p.y); if (!c) continue;
    if (p.cat === 'tree') { c.n_trees++; continue; }
    for (const k of p.cats) {
      if (k === 'cafe') c.n_cafe++; else if (k === 'food') c.n_food++; else if (k === 'gym') c.n_gym++;
      else if (k === 'night' || k === 'night_market') c.n_night++; else if (k === 'shop') c.n_shop++;
    }
  }
  for (const pts of treeRows) { // ~1 tree per 8 m of tree row
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 8));
      for (let k = 0; k < n; k++) { const c = cellAt(ax + ((bx - ax) * (k + 0.5)) / n, ay + ((by - ay) * (k + 0.5)) / n); if (c) c.n_trees++; }
    }
  }
  const q4 = cell / 4, s3 = cell / 3;
  for (const c of cells) {
    if (c.skip) continue; // outside every option's radius: not drawn, not scored
    // noise: energy-average of 5 sample points
    let ed = 0, en = 0;
    for (const [dx, dy] of [[0, 0], [-q4, -q4], [q4, -q4], [-q4, q4], [q4, q4]]) {
      const [d, n] = noiseAt(c.cx + dx, c.cy + dy); ed += 10 ** (d / 10); en += 10 ** (n / 10);
    }
    c.noise_day_db = 10 * Math.log10(ed / 5); c.noise_night_db = 10 * Math.log10(en / 5);
    // green fraction: 3x3 sample points
    let g = 0, wat = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const sx = c.x0 + s3 * (i + 0.5), sy = c.y0 + s3 * (j + 0.5);
      if (isWaterAt(sx, sy)) wat++; else if (isGreenAt(sx, sy)) g++;
    }
    c.green_frac = g / 9;
    // mostly river / lake / harbour: no roads and no shops make it look perfectly "calm", which says nothing about
    // staying there. Such cells get no scores and stay out of the percentiles of the land cells.
    c.water = wat >= 6;
    // neighbourhood sums (400 m, flat to 150 m then linear falloff)
    let ld = 0, ln = 0, am = 0; const catsSeen = new Set();
    for (const [p, d] of poisNear(c.cx, c.cy, 400)) {
      if (p.cat === 'tree') continue;
      const k = d <= 150 ? 1 : 1 - (d - 150) / 250;
      for (const cat of p.cats) {
        ld += k * (LIVELY_DAY[cat] || 0);
        ln += k * (LIVELY_NIGHT[cat] || 0);
        am += k * (AMENITY[cat] || 0);
        if (AMENITY[cat]) catsSeen.add(cat);
      }
    }
    c.lively_day_raw = ld; c.lively_night_raw = ln; c.amenities_raw = am + 3 * catsSeen.size;
    const treeDensity = c.n_trees / ((cell * cell) / 10000); // trees per hectare
    c.green_raw = c.green_frac + Math.min(0.5, treeDensity / 60);
  }
  // --- percentiles within the area (land cells only)
  const kept = cells.filter((c) => !c.skip);
  const land = kept.filter((c) => !c.water);
  if (!land.length) throw new UserError('every cell of this area is water; pick an area on land');
  const P = (key) => pct(land.map((c) => c[key]));
  const pNoiseD = P('noise_day_db'), pNoiseN = P('noise_night_db'), pLD = P('lively_day_raw'), pLN = P('lively_night_raw');
  const calmD = pct(land.map((_, i) => 0.75 * pNoiseD[i] + 0.25 * pLD[i]));
  const calmN = pct(land.map((_, i) => 0.65 * pNoiseN[i] + 0.35 * pLN[i]));
  const pGreen = P('green_raw'), pAm = P('amenities_raw');
  const r2 = (v) => Math.round(v * 100) / 100;
  const landIdx = new Map(land.map((c, i) => [c, i]));
  const features = kept.map((c) => {
    const ring = [[c.x0, c.y0], [c.x0 + cell, c.y0], [c.x0 + cell, c.y0 + cell], [c.x0, c.y0 + cell], [c.x0, c.y0]].map(([x, y]) => [round6(LNG(x)), round6(LAT(y))]);
    if (c.water) return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id: `c${c.ix}-${c.iy}`, name: 'Water', water: true } };
    const i = landIdx.get(c);
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {
      id: `c${c.ix}-${c.iy}`, name: 'Area estimate',
      calm_day: r2(1 - calmD[i]), calm_night: r2(1 - calmN[i]), lively_day: r2(pLD[i]), lively_night: r2(pLN[i]),
      green: r2(pGreen[i]), amenities: r2(pAm[i]),
      n_cafe: c.n_cafe, n_food: c.n_food, n_gym: c.n_gym, n_night: c.n_night, n_trees: c.n_trees,
      noise_day_db: Math.round(c.noise_day_db), noise_night_db: Math.round(c.noise_night_db), green_frac: r2(c.green_frac),
    } };
  });

  const file = path.join(site.dir, 'data', `${layer}.geojson`);
  const cl = configLayer(site, layer);
  const target = cl && typeof cl.data === 'string' && !/^https?:/i.test(cl.data) ? path.resolve(site.dir, cl.data) : file;
  if (!target.startsWith(site.dir + path.sep)) throw new UserError(`layer "${layer}" data path points outside the site`);
  const bytes = writeGeoJSON(target, { type: 'FeatureCollection', uw: { cmd: 'feel', generated_at: new Date().toISOString(), estimated: true }, features });
  const metaFile = target.replace(/\.geojson$/, '') + '.meta.json';
  const counts = { roads: roads.length, rail_ways: rails.length, runways: runways.length, airports: aerodromes.length, green_areas: greens.length, water_areas: waters.length, water_cells: kept.length - land.length, trees: nTrees, tree_rows: treeRows.length, pois: pois.length - nTrees };
  writeJSON(metaFile, {
    estimated: true,
    disclaimer: 'Estimated from OpenStreetMap features, not measured. Noise is a rough model of road class, rail and airport distance (plus nightlife at night); lively/amenities count mapped places. Scores are percentiles within this area only (0 = least, 1 = most), so they compare places inside the map, not between cities.',
    method: {
      grid: `square cells of ${cell} m`,
      noise: 'per cell, energy-sum of line sources (road dB at 10 m: motorway 80, trunk 77, primary 74, secondary 70, tertiary 66, links -4; rail 72-78) attenuated 10·log10(d/10) + 0.02 dB/m urban screening, cutoff 400 m; runways 74 dB at 300 m, 15·log10 falloff to 6 km; night: roads -7/-9 dB, rail -8 (metro -14), aircraft -12, + bars/clubs (66 dB @10 m) and night markets (74 dB) within 150 m; baseline 45/37 dB; average of 5 sample points',
      calm: 'calm_day = 1 - percentile(0.75·percentile(noise_day) + 0.25·percentile(lively_day)); calm_night = 1 - percentile(0.65·percentile(noise_night) + 0.35·percentile(lively_night))',
      lively: 'distance-weighted (flat to 150 m, zero at 400 m) sum of POIs; day: food 1, café 1.2, shop 0.5, culture 0.8, hotel 0.3, daily needs 0.6, bars 0.4, night market 0.5; night: bars/clubs 2.5, night market 6, food 0.7, daily 0.3, shop 0.15',
      green: 'fraction of 3×3 sample points inside parks/gardens/woods/grass/cemeteries, + tree density bonus (≤ 0.5 at 60 trees/ha), then percentile',
      water: 'cells with ≥ 6 of 9 sample points in rivers/lakes/reservoirs (OSM water polygons) get water: true and no scores; percentiles use land cells only. The sea (coastline) is not detected',
      amenities: 'weighted POIs within 400 m (daily needs 1.5, food 1, café 1, gym 1, culture 0.7, shop 0.3, transit/bike 0.7) + 3 per distinct category, then percentile',
      engine_score: 'score = (1-v)·calm_t + v·lively_t; score = 0.85·score + 0.15·green; t = night when h < 6 or h >= 19',
    },
    fields: {
      calm_day: '0-1, quieter and less busy than the rest of the area by day', calm_night: '0-1, same at night',
      lively_day: '0-1, density of cafés/food/shops/culture', lively_night: '0-1, bars, clubs, night markets, late food',
      green: '0-1, parks, greenery and street trees', amenities: '0-1, daily needs within ~5 min walk',
      n_cafe: 'cafés in the cell', n_food: 'restaurants/fast food in the cell', n_gym: 'gyms in the cell', n_night: 'bars/clubs/karaoke/night markets in the cell',
      n_trees: 'mapped trees in the cell (tree rows ≈ 1 per 8 m)', noise_day_db: 'rough modelled noise level by day (dB, estimate)', noise_night_db: 'same at night', green_frac: 'share of the cell inside green areas',
    },
    sources: ['OpenStreetMap contributors (ODbL) via Overpass API'],
    attribution: '© OpenStreetMap contributors',
    osm_timestamp: data.osm3s?.timestamp_osm_base || null,
    generated_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    bbox, ...(aroundPts ? { around: { layer: args.around, radius_m: R, points: aroundPts.length, query_boxes: Bs.length } } : {}), cell_m: cell, cells: features.length, grid: [nx, ny], counts,
  }, { pretty: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const rel = path.relative(site.dir, target).split(path.sep).join('/');
  const hint = layerHint(site, layer, 'grid', { title: 'Calm ↔ lively (est.)' });
  const registered = registerLayer(site, hint, { also: (cfg) => { if (cfg.vibe) return null; cfg.vibe = { enabled: true, default: 0.4, grid: layer }; return 'added "vibe" (the calm ↔ lively dial)'; } });
  const landF = features.filter((f) => !f.properties.water);
  const best = (k) => { let b = landF[0]; for (const f of landF) if (f.properties[k] > b.properties[k]) b = f; return b; };
  const top = (k) => landF.slice().sort((a, b) => b.properties[k] - a.properties[k]).slice(0, 3).map((f) => f.properties.id);
  if (counts.pois < 20) out.warn(`only ${counts.pois} POIs found: OSM coverage here may be thin, so lively/amenities scores are weak.`);
  out.result({ ok: true, file: rel, meta: path.relative(site.dir, metaFile).split(path.sep).join('/'), cells: features.length, grid: [nx, ny], cell_m: cell, bytes, seconds: Number(secs),
    fetch_seconds: Number(((tFetched - t0) / 1000).toFixed(1)), cached: !!data._cached, counts,
    calmest_night: top('calm_night'), liveliest_night: top('lively_night'), greenest: top('green'), registered_layer: registered ? hint : null,
    vibe_config: site.config?.vibe || null }, [
    `Wrote ${features.length} cells (${aroundPts ? `within ${R} m of ${aroundPts.length} points` : `${nx}×${ny}`} @ ${cell} m, ${fmtBytes(bytes)}) to ${rel} + meta in ${secs}s.`,
    `From OSM: ${counts.roads} major road ways, ${counts.rail_ways} rail ways, ${counts.runways} runways, ${counts.green_areas} green areas, ${counts.trees} trees, ${counts.pois} POIs.`,
    `Noise est. ${Math.round(Math.min(...land.map((c) => c.noise_day_db)))}-${Math.round(Math.max(...land.map((c) => c.noise_day_db)))} dB by day. Greenest cell ${best('green').properties.id}, liveliest at night ${best('lively_night').properties.id}.${land.length < kept.length ? ` ${kept.length - land.length} water cells have no scores.` : ''}`,
    registered,
  ]);
}

function isWater(t) {
  return t.natural === 'water' || t.waterway === 'riverbank' || /^(reservoir|basin)$/.test(t.landuse || '');
}
function isGreen(t) {
  return /^(park|garden|nature_reserve)$/.test(t.leisure || '') || /^(grass|forest|recreation_ground|cemetery|meadow|village_green)$/.test(t.landuse || '') ||
    /^(wood|scrub|grassland)$/.test(t.natural || '');
}

const LIVELY_DAY = { food: 1, cafe: 1.2, shop: 0.5, culture: 0.8, hotel: 0.3, daily: 0.6, night: 0.4, night_market: 0.5, gym: 0.3 };
const LIVELY_NIGHT = { night: 2.5, night_market: 6, food: 0.7, daily: 0.3, shop: 0.15, culture: 0.2 };
const AMENITY = { daily: 1.5, food: 1, cafe: 1, gym: 1, culture: 0.7, shop: 0.3, transit: 0.7 };

function poiCats(t, NM) {
  const c = [];
  const a = t.amenity, s = t.shop;
  const nm = new RegExp(NM);
  if ((a === 'marketplace' || t.place || t.landuse || t.highway || t.tourism) && t.name && nm.test(t.name)) c.push('night_market');
  if (a === 'cafe' || s === 'coffee' || s === 'tea') c.push('cafe');
  if (/^(restaurant|fast_food|food_court|ice_cream)$/.test(a || '') || (a === 'marketplace' && !c.includes('night_market'))) c.push('food');
  if (/^(bar|pub|nightclub|biergarten|karaoke_box)$/.test(a || '') || t.leisure === 'dance') c.push('night');
  if (a === 'gym' || t.leisure === 'fitness_centre' || (t.leisure === 'sports_centre' && /fitness|gym|crossfit|weight/.test(t.sport || ''))) c.push('gym');
  if (/^(supermarket|convenience|greengrocer|bakery|butcher|laundry|dry_cleaning|chemist|deli)$/.test(s || '') || /^(pharmacy|bank|post_office|clinic|doctors)$/.test(a || '')) c.push('daily');
  if (s && !c.includes('daily') && !c.includes('cafe')) c.push('shop');
  if (/^(cinema|theatre|arts_centre|library|community_centre)$/.test(a || '') || /^(attraction|museum|gallery|viewpoint|artwork)$/.test(t.tourism || '')) c.push('culture');
  if (/^(hotel|hostel|guest_house)$/.test(t.tourism || '')) c.push('hotel');
  if (a === 'bicycle_rental') c.push('transit');
  return c;
}

// Percentile rank 0..1 (ties share a rank; the minimum maps to 0, the maximum to 1).
export function pct(values) {
  const n = values.length;
  if (n < 2) return values.map(() => 0.5);
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n);
  let i = 0;
  const min = idx[0][0], max = idx[n - 1][0];
  if (max - min < 1e-9) return values.map(() => 0.5);
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs(idx[j + 1][0] - idx[i][0]) < 1e-9) j++;
    const v = idx[i][0];
    const r = v === min ? 0 : v === max ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}
