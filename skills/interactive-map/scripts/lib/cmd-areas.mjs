// `areas`: named areas with verdicts ("Quiet at night · Dadaocheng back lanes") from the feel grid. ENGINE-SPEC-v0.2 §6.1.
// Turns 300 noisy 200 m squares into 2-5 soft shapes a person can read, each with a verdict, a name and a "why" built
// from numbers only. Estimates stay labelled as estimates.
import path from 'node:path';
import { parseArgs, makeOut, readJSON, writeGeoJSON, exists, haversine, representativePoint, pointInPolygonGeom, round6, parseList, UsageError, UserError, skipped as skipLine } from './util.mjs';
import { overpass } from './net.mjs';
import { openSite, checkLayerId, loadLayer, layerPath, assertOwned, layerHint, registerLayer, configLayer } from './site.mjs';
import { cellsToPolygon, polylabel, lengthInside, simplifyRing } from './geo.mjs';
import { mergeMetrics } from './metrics.mjs';
import { hasLatin, hasCJK } from '../adapters/lib/twnorm.mjs';

export const LENSES = {
  quiet_night: { field: 'calm_night', dir: 'high', verdict: 'Quiet at night', time: [19, 30], word: 'quietest', when: 'at night', quiet: true, blocks: 'Quiet blocks at night', streets: 'Quiet streets', short: 'Quiet' },
  lively_night: { field: 'lively_night', dir: 'high', verdict: 'Lively at night', time: [18, 26], word: 'liveliest', when: 'at night', blocks: 'Lively blocks at night', streets: 'Lively streets', short: 'Lively' },
  quiet_day: { field: 'calm_day', dir: 'high', verdict: 'Calm by day', time: [6, 19], word: 'calmest', when: 'by day', quiet: true, blocks: 'Calm blocks by day', streets: 'Calm streets', short: 'Calm' },
  lively_day: { field: 'lively_day', dir: 'high', verdict: 'Busy by day', time: [8, 20], word: 'busiest', when: 'by day', blocks: 'Busy blocks by day', streets: 'Busy streets', short: 'Busy' },
  green: { field: 'green', dir: 'high', verdict: 'Green and leafy', time: null, word: 'greenest', when: '', blocks: 'Green blocks', streets: 'Green streets', short: 'Green' },
  amenities: { field: 'amenities', dir: 'high', verdict: 'Everything nearby', time: null, word: 'best-served for daily needs', when: '', blocks: 'Well-served blocks', short: 'Served' },
};

export const help = `areas <dir> [--grid feel] [--lens quiet_night,lively_night,green] [--within walk] [--options hotels]
            [--top 0.2] [--min-cells 3] [--max 5] [--smooth 2] [--names '{"quiet_night-1":"Dadaocheng back lanes"}']
            [--near coffeewalk --radius 400] [--avoid nightmarkets:150] [--layer areas] [--force] [--json]
  Finds the top --top share (default 20%) of land cells of the feel grid for each lens, joins touching cells
  (8-connected), drops groups under --min-cells, keeps the --max best (cells × mean), and draws each as one soft
  polygon (holes ≤ 2 cells filled, +¼ cell buffer, Chaikin --smooth). Names come from one Overpass query: a named
  park inside (first for "green"), else the nearest neighbourhood/quarter inside or ≤ 300 m, else "near <the
  longest named street inside>" (a quiet area is never named after the main road through it), else "Area n".
  --names renames ('{"id":"English"}' drops the old local name; "English|中文" sets both).
  --near <layer> --radius m: keep only areas with a cell within m of that layer (a walk, a route, the options).
  --avoid <layer>[:m] (default: the config's night-market layer, 150 m): quiet lenses never count a cell within m
  of a place open in the lens's hours (a night market 18:00-00:00 is not a quiet block at night).
  Writes data/<layer>.geojson (verdict, name, name_local, why, basis "estimated", confidence, cells, share, mean,
  field, options, label_at, rank, needs_english).
  Lenses: ${Object.entries(LENSES).map(([k, v]) => `${k} (${v.field}, "${v.verdict}")`).join(', ')}.
  Custom lens: --lens key=<field>:<high|low>:"Verdict text" or "Verdict text|word" (word reads "among the <word> 20%").
  --within walk --options hotels: also writes <lens>_blocks onto each option (cells of the DRAWN areas inside its own
  walk area, so the number can be counted on the map) plus a metrics.json entry (basis estimated, unit blocks).
  e.g. quiet_night_blocks: 12.
  Registers in map.config.json (if absent): { "id": "areas", "type": "areas", "data": "data/areas.geojson", "role": "verdict" }`;

export async function run(argv) {
  const args = parseArgs(argv, { grid: 'string', lens: 'string', within: 'string', options: 'string', top: 'number', 'min-cells': 'number', max: 'number',
    smooth: 'number', names: 'string', layer: 'string', force: 'bool', 'no-names': 'bool', near: 'string', radius: 'number', avoid: 'string' }, { positionals: [1, 1], command: 'areas' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer || 'areas');
  assertOwned(site, layer, 'areas', args.force);
  const gridId = args.grid || site.config?.vibe?.grid || (site.config?.layers || []).find((l) => l?.type === 'grid')?.id || 'feel';
  if (!exists(layerPath(site, gridId))) throw skipLine(`areas: no feel grid "${gridId}" yet (feel was skipped or not run); the map works without it. Run first: uw feel ${site.rel} --around <layer>`);
  const grid = loadLayer(site, gridId);
  const top = args.top ?? 0.2, minCells = args['min-cells'] ?? 3, maxN = args.max ?? 5, smooth = args.smooth ?? 2;
  if (!(top > 0 && top < 1)) throw new UsageError('--top must be between 0 and 1 (e.g. 0.2 = the top 20%)');
  let names = {};
  if (args.names) { try { names = JSON.parse(args.names); } catch (e) { throw new UsageError(`--names is not valid JSON: ${e.message}`); } }
  // lenses
  const lensList = [];
  for (const spec of parseList(args.lens || 'quiet_night,lively_night')) {
    const m = spec.match(/^([a-z][a-z0-9_]*)=([a-z0-9_]+):(high|low):(.+)$/i);
    if (m) {
      // "Verdict|word": the optional word reads in "N blocks among the <word> 20% of this map" (e.g. "most café-dense")
      const [verdict, word] = m[4].replace(/^["']|["']$/g, '').split('|');
      lensList.push({ id: m[1], field: m[2], dir: m[3], verdict: verdict.trim(), time: null, word: word?.trim() || (m[3] === 'high' ? `highest ${m[2].replace(/_/g, ' ')}` : `lowest ${m[2].replace(/_/g, ' ')}`), when: '' });
    }
    else if (LENSES[spec]) lensList.push({ id: spec, ...LENSES[spec] });
    else throw new UsageError(`unknown lens "${spec}". Built-in: ${Object.keys(LENSES).join(', ')}; custom: key=<field>:<high|low>:"Verdict"`);
  }
  // grid cells by col,row
  const cells = [];
  let dx = null, dy = null, w0 = null, s0 = null;
  for (const f of grid.features) {
    const m = String(f?.properties?.id || '').match(/^c(\d+)-(\d+)$/);
    if (!m || !f.geometry) continue;
    const col = Number(m[1]), row = Number(m[2]);
    const ring = f.geometry.coordinates[0];
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (dx === null) { dx = b[2] - b[0]; dy = b[3] - b[1]; w0 = b[0] - col * dx; s0 = b[1] - row * dy; }
    cells.push({ col, row, p: f.properties, water: !!f.properties.water, c: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] });
  }
  if (!cells.length) throw new UserError(`grid "${gridId}" has no cells with ids like c<col>-<row> (made by uw feel)`);
  const land = cells.filter((c) => !c.water);
  const toLngLat = ([x, y]) => [round6(w0 + x * dx), round6(s0 + y * dy)];
  const cellM = Math.round(haversine([w0, s0], [w0 + dx, s0]));
  // walk polygons for option counts
  let walk = null, options = null;
  if (args.within || args.options) {
    if (!args.within || !args.options) throw new UsageError('--within and --options go together (e.g. --within walk --options hotels)');
    if (!exists(layerPath(site, args.within))) throw skipLine(`areas: no "${args.within}" walk areas yet (isochrone was skipped or not run); run uw isochrone ${site.rel} --layer ${args.within} --from layer:${args.options} first, or drop --within/--options`);
    walk = loadLayer(site, args.within).features.filter((f) => f?.properties?.for != null && /Polygon/.test(f.geometry?.type || ''));
    options = loadLayer(site, args.options);
    if (!walk.length) throw new UserError(`layer "${args.within}" has no polygons with "for" (make them with uw isochrone … --from layer:${args.options})`);
  }
  // --near: areas must touch this layer (a walk, a route, the options)
  let nearPts = null;
  if (args.near) {
    const fc = loadLayer(site, args.near);
    nearPts = [];
    const add = (c) => { if (Array.isArray(c) && typeof c[0] === 'number') nearPts.push(c); else if (Array.isArray(c)) c.forEach(add); };
    for (const f of fc.features || []) if (f?.geometry) add(f.geometry.coordinates);
    if (!nearPts.length) throw new UserError(`--near ${args.near}: the layer has no coordinates`);
  }
  const nearR = args.radius ?? 400;
  const isNear = (comp) => !nearPts || comp.some((c) => nearPts.some((p) => haversine(c.c, p) <= nearR + cellM / 2));
  // --avoid: places that are loud in a lens's hours (night markets): cells near them are never "quiet" then
  let avoid = [];
  const avoidSpec = args.avoid ?? (() => {
    const d = (site.config?.layers || []).find((l) => l?.type === 'points' && exists(layerPath(site, l.id)) && (loadLayer(site, l.id).features || []).some((f) => /night_?market/.test(String(f.properties?.kind || ''))));
    return d ? `${d.id}:150` : null;
  })();
  if (avoidSpec && avoidSpec !== 'none') {
    const [aid, am] = String(avoidSpec).split(':');
    const fc = loadLayer(site, aid);
    const m = Number(am) || 150;
    avoid = (fc.features || []).filter((f) => f?.geometry?.type === 'Point').map((f) => ({ c: f.geometry.coordinates, m, name: f.properties.name_en || f.properties.name, from: f.properties.time_from, to: f.properties.time_to, kind: f.properties.kind }));
  }
  const openIn = (a, win) => {
    if (!win) return true;
    if (a.from == null || a.to == null) return /night/.test(String(a.kind || '')) && win[1] > 24; // hours unknown: a night market is open at night
    const [s1, e1] = win, s2 = a.from, e2 = a.to > a.from ? a.to : a.to + 24;
    return [0, 24, -24].some((k) => s2 + k < e1 && e2 + k > s1);
  };
  const walkOf = (id) => { const ps = walk.filter((p) => String(p.properties.for) === String(id)); return ps.length ? ps.reduce((a, b) => ((b.properties.minutes || 0) > (a.properties.minutes || 0) ? b : a)) : null; };
  const walkMin = walk ? Math.max(...walk.map((p) => p.properties.minutes || 0)) || 10 : 10;

  const areas = [], lensSummary = [], optionCounts = {};
  for (const L of lensList) {
    const vals = land.map((c) => c.p[L.field]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (!vals.length) throw new UserError(`grid "${gridId}" has no "${L.field}" values (lens ${L.id})`);
    const score = (v) => (L.dir === 'high' ? v : 1 - v);
    const sv = vals.map(score).sort((a, b) => a - b);
    const thr = sv[Math.min(sv.length - 1, Math.max(0, Math.floor((1 - top) * sv.length)))];
    // a quiet lens drops cells next to something loud in its own hours (a night market 18:00-00:00)
    const loud = L.quiet ? avoid.filter((a) => openIn(a, L.time)) : [];
    let avoided = 0;
    const topCells = land.filter((c) => {
      if (!(typeof c.p[L.field] === 'number' && score(c.p[L.field]) >= thr)) return false;
      if (loud.some((a) => haversine(c.c, a.c) <= a.m + cellM / 2)) { avoided++; return false; }
      return true;
    });
    const key = new Map(topCells.map((c) => [c.col + ',' + c.row, c]));
    // 8-connected components
    const seen = new Set(), comps = [];
    for (const c of topCells) {
      const k0 = c.col + ',' + c.row;
      if (seen.has(k0)) continue;
      const comp = [], stack = [c]; seen.add(k0);
      while (stack.length) {
        const x = stack.pop(); comp.push(x);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          const k = (x.col + a) + ',' + (x.row + b);
          if ((a || b) && key.has(k) && !seen.has(k)) { seen.add(k); stack.push(key.get(k)); }
        }
      }
      comps.push(comp);
    }
    const kept = comps.filter((c) => c.length >= minCells && isNear(c))
      .map((comp) => ({ comp, mean: comp.reduce((s, c) => s + score(c.p[L.field]), 0) / comp.length }))
      .map((x) => ({ ...x, s: x.comp.length * x.mean })).sort((a, b) => b.s - a.s).slice(0, maxN);
    lensSummary.push({ id: L.id, field: L.field, dir: L.dir, verdict: L.verdict, threshold: Math.round(thr * 100) / 100, top_cells: topCells.length, groups: comps.length, kept: kept.length, ...(avoided ? { avoided_cells: avoided, avoided_near: loud.map((a) => a.name).filter(Boolean).slice(0, 8) } : {}) });
    kept.forEach((k, i) => {
      const poly = cellsToPolygon(k.comp.map((c) => [c.col, c.row]), { smooth, buffer: 0.25, maxHole: 2 });
      if (!poly) return;
      const outer = simplifyRing(poly.outer.map(toLngLat), 2);
      const holes = poly.holes.map((h) => simplifyRing(h.map(toLngLat), 2)).filter((h) => h.length >= 4);
      const geometry = { type: 'Polygon', coordinates: [outer, ...holes] };
      const fieldVals = k.comp.map((c) => c.p[L.field]);
      const mu = fieldVals.reduce((a, b) => a + b, 0) / fieldVals.length;
      const sd = Math.sqrt(fieldVals.reduce((a, b) => a + (b - mu) ** 2, 0) / fieldVals.length);
      const meanOf = (f) => { const v = k.comp.map((c) => c.p[f]).filter((x) => typeof x === 'number'); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
      const mean = Object.fromEntries(['calm_day', 'calm_night', 'lively_day', 'lively_night', 'green', 'amenities'].map((f) => [f, meanOf(f)]).filter(([, v]) => v != null));
      const id = `${L.id}-${i + 1}`;
      const props = {
        id, name: null, name_local: null, lens: L.id, field: L.field, verdict: L.verdict,
        ...(L.time ? { time_from: L.time[0], time_to: L.time[1] } : {}),
        why: null, basis: 'estimated', confidence: k.comp.length >= 8 && sd < 0.12 ? 'medium' : 'low',
        cells: k.comp.length, share: Math.round((k.comp.length / land.length) * 1000) / 1000, mean,
        label_at: polylabel([outer, ...holes], Math.max(3, cellM / 20)), rank: i + 1, needs_english: false,
      };
      if (options) {
        props.options = {};
        for (const o of options.features) {
          const wp = walkOf(o.properties.id);
          props.options[o.properties.id] = wp ? k.comp.filter((c) => pointInPolygonGeom(c.c, wp.geometry)).length : 0;
        }
      }
      if (loud.length) props.avoided = loud.length;
      areas.push({ type: 'Feature', geometry, properties: props, _lens: L, _comp: k.comp });
    });
    if (options) {
      // only cells of the areas that are drawn: "13 quiet blocks" must be countable on the map
      const drawn = kept.flatMap((k) => k.comp);
      for (const o of options.features) {
        const wp = walkOf(o.properties.id);
        (optionCounts[o.properties.id] ||= {})[`${L.id}_blocks`] = wp ? drawn.filter((c) => pointInPolygonGeom(c.c, wp.geometry)).length : null;
      }
    }
  }

  // --- naming + main roads (one Overpass query over all areas)
  let places = [], roads = [], parks = [];
  if (areas.length && !args['no-names']) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const a of areas) for (const [x, y] of a.geometry.coordinates[0]) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
    const ob = `${(b[1] - 0.003).toFixed(6)},${(b[0] - 0.003).toFixed(6)},${(b[3] + 0.003).toFixed(6)},${(b[2] + 0.003).toFixed(6)}`;
    const q = `[out:json][timeout:60];
node["place"~"^(neighbourhood|quarter|suburb)$"]["name"](${ob});
out qt;
way["highway"~"^(trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"]["name"](${ob});
out geom qt;
(way["leisure"="park"]["name"](${ob});relation["leisure"="park"]["name"](${ob}););
out center tags qt;`;
    try {
      out.log('Querying OpenStreetMap for place names and main streets…');
      const data = await overpass(q, { timeoutS: 60 });
      for (const e of data.elements || []) {
        if (e.tags?.leisure === 'park' && e.center) parks.push({ c: [e.center.lon, e.center.lat], name: e.tags.name, en: e.tags['name:en'] || (hasLatin(e.tags.name) ? e.tags.name : null) });
        else if (e.type === 'node') places.push({ c: [e.lon, e.lat], name: e.tags.name, en: e.tags['name:en'] || (hasLatin(e.tags.name) ? e.tags.name : null), place: e.tags.place });
        else if (e.type === 'way' && e.geometry) roads.push({ coords: e.geometry.map((p) => [p.lon, p.lat]), cls: e.tags.highway, name: e.tags.name || null, en: e.tags['name:en'] || null });
      }
    } catch (e) { out.warn(`naming skipped (${e.message}); areas are called "Area n" — re-run later or pass --names`); }
  }
  const PLACE_RANK = { neighbourhood: 0, quarter: 1, suburb: 2 };
  areas.forEach((a, n) => {
    const p = a.properties, g = a.geometry;
    const inside = (c) => pointInPolygonGeom(c, g);
    const cand = places.map((pl) => ({ ...pl, d: inside(pl.c) ? 0 : haversine(pl.c, p.label_at) }))
      .filter((pl) => pl.d === 0 || pl.d <= 300).sort((x, y) => (x.d - y.d) || (PLACE_RANK[x.place] - PLACE_RANK[y.place]));
    let en = null, local = null;
    const L0 = a._lens;
    // a named park inside names a green area best (and is a good name for any other)
    const park = parks.filter((pk) => inside(pk.c)).sort((x, y) => haversine(x.c, p.label_at) - haversine(y.c, p.label_at))[0];
    // a neighbourhood/quarter names an area best; a whole district (suburb) is too coarse when a street can say more
    const fine = cand.filter((pl) => pl.place !== 'suburb');
    if (park && (L0.field === 'green' || (L0.quiet && !fine.length))) { en = park.en; local = hasLatin(park.name) ? null : park.name; }
    else if (fine.length) { en = fine[0].en; local = fine[0].name; }
    else {
      // a quiet area is never named after the main road that runs through it
      const MAIN = ['trunk', 'primary', 'secondary'];
      const named = roads.filter((r) => r.name && !(L0.quiet && MAIN.includes(r.cls)) && r.cls !== 'trunk' && !/快速|高架|[Ee]xpressway|[Vv]iaduct/.test(r.name + ' ' + (r.en || ''))).map((r) => ({ ...r, len: lengthInside(r.coords, inside) })).filter((r) => r.len > 0);
      const byName = new Map();
      for (const r of named) { const k = r.name; const prev = byName.get(k); byName.set(k, { ...r, len: (prev?.len || 0) + r.len, en: prev?.en || r.en }); }
      const best = [...byName.values()].sort((x, y) => y.len - x.len)[0];
      if (best && best.len >= 150) { en = best.en ? `near ${best.en}` : hasLatin(best.name) ? `near ${best.name}` : null; local = hasLatin(best.name) ? null : `${best.name}一帶`; } // 一帶 ("around") only for CJK street names
      else if (cand.length) { en = cand[0].en; local = cand[0].name; }
    }
    // --names: "English" replaces the name (and drops the old local one); "English|中文" sets both
    if (names[p.id]) { const [ne, nl] = String(names[p.id]).split('|'); en = ne.trim().slice(0, 60); local = nl ? nl.trim().slice(0, 60) : null; }
    p.name = en || local || `Area ${n + 1}`;
    if (local && local !== p.name) p.name_local = local; else delete p.name_local;
    p.needs_english = !hasLatin(p.name) || /^Area \d+$/.test(p.name);
    if (/^Area \d+$/.test(p.name)) p.unnamed = true;
    if (p.name_local === null) delete p.name_local;
    // main roads inside (quiet lenses only say "no main road inside" when that is true)
    const main = roads.filter((r) => ['trunk', 'primary', 'secondary'].includes(r.cls)).reduce((s, r) => s + lengthInside(r.coords, inside), 0);
    const L = a._lens;
    const pct = Math.round(top * 100);
    let why = `${p.cells} blocks among the ${L.word} ${pct}% of this map${L.when ? ' ' + L.when : ''}`;
    if (L.quiet && roads.length) why += main < 50 ? '; no main road inside' : `; a main road runs through it (${Math.round(main)} m)`;
    if (L.quiet && p.avoided) why += '; blocks next to a night market in its hours left out';
    p.why = (why + ' (est.)').slice(0, 140);
    delete a._lens; delete a._comp;
  });

  const fc = {
    type: 'FeatureCollection', attribution: '© OpenStreetMap contributors',
    method: `Top ${Math.round(top * 100)}% of land cells (${cellM} m squares from uw feel) per lens, 8-connected groups of ≥ ${minCells} cells, best ${maxN} by cells × mean; ` +
      `holes ≤ 2 cells filled, +¼ cell buffer, Chaikin ×${smooth}.${avoid.length ? ` Quiet lenses leave out cells within ${avoid[0].m} m of ${args.avoid ? args.avoid.split(':')[0] : 'the night markets'} open in their hours.` : ''} Names: a named park inside, the nearest OSM neighbourhood/quarter inside or ≤ 300 m, else the longest named street inside (never a main road for a quiet area). Estimates, not measurements.`,
    lenses: lensSummary, features: areas,
  };
  const p = layerPath(site, layer);
  assertOwned(site, layer, 'areas', args.force);
  fc.uw = { cmd: 'areas', generated_at: new Date().toISOString(), args: { grid: gridId, lens: lensList.map((l) => l.id).join(','), top, min_cells: minCells, max: maxN, ...(args.within ? { within: args.within, options: args.options } : {}) } };
  writeGeoJSON(p, fc);
  const wrote = [path.relative(site.dir, p).split(path.sep).join('/')];
  // option counts
  if (options) {
    for (const o of options.features) Object.assign(o.properties, Object.fromEntries(Object.entries(optionCounts[o.properties.id] || {}).filter(([, v]) => v != null)));
    writeGeoJSON(layerPath(site, args.options), options);
    wrote.push(path.relative(site.dir, layerPath(site, args.options)).split(path.sep).join('/'));
    const entries = {};
    for (const L of lensList) entries[`${L.id}_blocks`] = { label: (L.streets ? `${L.streets} within a ${walkMin}-min walk` : L.blocks || `${L.verdict} (blocks)`), short: L.short || L.id, unit: 'blocks', format: 'int', better: 'higher',
      basis: 'estimated', confidence: 'low', source: 'uw feel + uw areas (OpenStreetMap)', scale: `${cellM} m squares of the drawn areas inside the ${walkMin}-min walk`, layer,
      good: 15, bad: 0, threshold: 3, cap: 20, cmd: 'areas' };
    mergeMetrics(site.dir, entries, 'areas');
    wrote.push('data/metrics.json');
  }
  const hint = layerHint(site, layer, 'areas', { title: 'Areas (est.)', role: 'verdict' });
  const lines = [`Areas: ${areas.length} named area(s) from ${land.length} land cells of "${gridId}" (${cellM} m):`];
  for (const a of areas) lines.push(`  ${a.properties.id.padEnd(16)} ${a.properties.verdict} · ${a.properties.name}${a.properties.name_local ? ` (${a.properties.name_local})` : ''} · ${a.properties.cells} cells · ${a.properties.confidence}${a.properties.options ? ' · ' + Object.entries(a.properties.options).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`);
  if (options) for (const [id, c] of Object.entries(optionCounts)) lines.push(`  ${args.options}:${id} → ${Object.entries(c).map(([k, v]) => `${k}=${v ?? '—'}`).join(' ')}`);
  const noEn = areas.filter((a) => a.properties.needs_english).map((a) => a.properties.id);
  if (noEn.length) lines.push(`  ${noEn.length} area(s) without an English name: romanise with --names '{"${noEn[0]}":"…"}'`);
  const registered = registerLayer(site, hint);
  if (registered) lines.push(registered);
  out.result({ ok: true, layer, areas: areas.map((a) => a.properties), lenses: lensSummary, option_counts: optionCounts, wrote, registered_layer: registered ? hint : null }, lines);
  return 0;
}
