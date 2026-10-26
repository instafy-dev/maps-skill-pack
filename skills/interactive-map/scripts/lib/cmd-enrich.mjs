// `enrich`: add comparable metrics to each feature of a layer (in place).
import path from 'node:path';
import { parseArgs, makeOut, parseList, parseLngLat, parseBBox, bboxAround, haversine, representativePoint, pointInPolygonGeom, writeGeoJSON, readJSON, exists, sleep, assembleRings, UsageError, UserError, skipped as skipLine } from './util.mjs';
import { overpass, isSkip, partialLine } from './net.mjs';
import { walkTable } from './route-lookups.mjs';
import { nearestOnLine } from './geo.mjs';
import { openSite, checkLayerId, loadLayer, layerPath, listLayerIds, configLayer, titleCase } from './site.mjs';
import { mergeMetrics } from './metrics.mjs';

export const help = `enrich <dir> --layer <id> [--count cafes,gyms,…] [--within <isochroneLayer>] [--radius 800] [--nearest mrt,…] [--feel]
       [--feel-within <isochroneLayer>] [--route-to <layer> [--mode foot|bike]] [--json]
  Adds metrics to every feature of <layer> (file edited in place; other properties kept):
  --count L1,L2   number of L features inside the feature's linked isochrone → "<L>_<minutes>min" (e.g. cafes_10min).
                  The isochrone layer is --within, or auto-detected (a config "areas" layer with linkedTo = <layer>).
                  Without isochrones: straight-line --radius (default 800 m) → "<L>_<radius>m".
  --nearest L     straight-line distance to the nearest L feature → "nearest_<L>_m" (+ "nearest_<L>_name"). An L feature
                  that stands for an area (a park added from an OSM way/relation, or a polygon) is measured to its edge,
                  0 when inside (+ "nearest_<L>_inside"): a café in Vondelpark is "in the park", not "603 m".
                  Old values on features the run cannot measure are removed, never left stale.
  --feel          feel-grid scores at the feature's cell → calm_day, calm_night, lively_day, lively_night, green, amenities,
                  noise_day_db, noise_night_db (estimates; run "feel" first). That is the 200 m square at the door.
  --feel-within W the same scores averaged over every cell inside the feature's own polygon in areas layer W (its 10-min
                  walk) → calm_day_area, calm_night_area, lively_day_area, lively_night_area, green_area, amenities_area,
                  noise_night_db_area, area_cells. "How calm is the neighbourhood" rather than "how loud is the door".
  --route-to L    walking (or --mode bike) time to the nearest L feature by the street network (OSRM table, one request
                  per feature, nearest 4 by straight line considered) → walk_min_<L>, walk_km_<L>, walk_min_<L>_name.
  Features with "entrances" (tw-metro stations) are measured to their nearest entrance (--nearest, --route-to).
  Partial inputs: a layer marked partial (Photon fallback, --limit cut) or fetched for an area that misses some of
  <layer>'s features marks the metrics made from it partial in data/metrics.json (partial_reason, caveat "MRT data
  partial"); the verdict then shows the caveat and never calls an option shortest/longest on it. A complete re-fetch +
  enrich clears it.
  Layer ids with "-" become "_" in metric names. Use the metric keys in card.fields and compare.metrics.`;

const FEEL_KEYS = ['calm_day', 'calm_night', 'lively_day', 'lively_night', 'green', 'amenities', 'noise_day_db', 'noise_night_db'];

export async function run(argv) {
  const args = parseArgs(argv, { layer: 'string', count: 'string', within: 'string', radius: 'number', nearest: 'string', feel: 'bool', grid: 'string',
    'feel-within': 'string', 'route-to': 'string', mode: 'string' },
    { positionals: [1, 1], command: 'enrich' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  const counts = parseList(args.count), nearest = parseList(args.nearest);
  if (!counts.length && !nearest.length && !args.feel && !args['feel-within'] && !args['route-to']) throw new UsageError('nothing to do: give --count, --nearest, --feel, --feel-within and/or --route-to');
  const fc = loadLayer(site, layer);
  const targets = fc.features.filter((f) => f?.geometry && f.properties?.id != null);
  if (!targets.length) throw new UserError(`layer "${layer}" has no features with ids`);
  const key = (l) => l.replace(/-/g, '_');
  const warnings = [];
  const layerOf = {}; // metric → { layer, id_key } for metrics.json
  const added = new Set();
  let skipped = null; // a SkipError (deadline) during --route-to: the rest is still written
  let routedPartial = null; // { keys, reason, caveat, refetch }: --route-to stopped part way

  // Isochrone source
  let iso = null, isoLayer = args.within || null;
  if (counts.length) {
    if (!isoLayer) {
      const auto = (site.config?.layers || []).find((l) => l?.linkedTo === layer && (l.type === 'areas' || !l.type));
      if (auto && exists(layerPath(site, auto.id))) { isoLayer = auto.id; out.log(`Using isochrones from layer "${isoLayer}" (linkedTo ${layer}).`); }
      else {
        // not in the config yet: any isochrone file made from this layer (its polygons carry for_layer)
        for (const id of listLayerIds(site)) {
          let fc2 = null; try { fc2 = loadLayer(site, id, { required: false }); } catch { continue; }
          if (fc2?.uw?.cmd === 'isochrone' && fc2.features.some((f) => f?.properties?.for_layer === layer)) { isoLayer = id; out.log(`Using isochrones from layer "${id}" (made from ${layer}).`); break; }
        }
      }
    }
    if (isoLayer) {
      iso = loadLayer(site, isoLayer).features.filter((f) => f?.properties?.for != null && /Polygon/.test(f.geometry?.type || ''));
      if (!iso.length) throw new UserError(`layer "${isoLayer}" has no polygons with a "for" property. Make them with: uw.mjs isochrone ${site.rel} --layer ${isoLayer} --from layer:${layer}`);
    }
  }
  const radius = args.radius ?? 800;
  if (radius <= 0 || radius > 20000) throw new UsageError('--radius must be 1-20000 m');

  const pointsOf = (l) => loadLayer(site, l).features.filter((f) => f?.geometry).map((f) => ({ f, c: representativePoint(f.geometry) })).filter((x) => x.c);
  // where you walk to: a station's entrances when it has them (the platform centre can be 200 m from the nearest door)
  const doorsOf = (l) => pointsOf(l).flatMap((x) => {
    const es = Array.isArray(x.f.properties?.entrances) ? x.f.properties.entrances.filter((e) => Array.isArray(e?.c) && e.c.every(Number.isFinite)) : [];
    return es.length ? es.map((e) => ({ f: x.f, c: e.c, entrance: e.ref ?? true })) : [x];
  });
  // a layer whose places step was skipped (Overpass busy) has no file: measure the rest, say what is missing
  const missingLayers = [];
  const present = (l) => {
    if (exists(layerPath(site, l))) return true;
    missingLayers.push(l);
    warnings.push(`layer "${l}" has no data yet (its places step was skipped or not run): metrics against it left out. Run it, then enrich again.`);
    return false;
  };

  // Area a scripted layer was fetched for (from its "uw.args"), to flag counts that run past the data's edge.
  const coverage = (l) => {
    try {
      const a = loadLayer(site, l).uw?.args || {};
      if (a.source === 'tw-metro' && !a.near && !a.bbox) return null;
      if (a.appended) return null; // several calls merged: no single area to check against
      if (a.near) return bboxAround(parseLngLat(a.near), a.radius ?? 800);
      if (a.bbox) return parseBBox(a.bbox);
    } catch {}
    return null;
  };
  const inside = (c, b) => c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];
  // Is a layer's data complete for what we measure here? Its own partial mark, or targets outside the area it was
  // fetched for (an option added or moved after its places step: its "nearest station" may be one never fetched).
  const partialInfo = new Map();
  const partialOf = (l) => {
    if (partialInfo.has(l)) return partialInfo.get(l);
    let fc = null; try { fc = loadLayer(site, l); } catch {}
    const why = [];
    let refetch = fc?.uw?.partial?.refetch || null;
    // `via`: places came from a fallback provider of the places chain (any; "photon" in files from before the chain)
    if (!refetch && fc?.uw?.args?.via && fc.uw.cmd === 'places' && fc.uw.args.kinds && fc.uw.args.around)
      refetch = `uw places ${site.rel} --layer ${l} --kinds ${fc.uw.args.kinds} --around ${fc.uw.args.around} --radius ${fc.uw.args.radius ?? 1000} --force`;
    const own = fc?.uw?.partial?.reason || (typeof configLayer(site, l)?.partial === 'string' ? configLayer(site, l).partial : null)
      // files written before partial marks existed: a fallback provider's answer is partial all the same
      || (fc?.uw?.args?.via ? `it came from ${fc.uw.args.via_label || fc.uw.args.via} while Overpass could not answer (names and positions only; it can miss places)` : null);
    if (own) why.push(own);
    const circles = Array.isArray(fc?.uw?.coverage?.circles) ? fc.uw.coverage.circles : null;
    const box = circles ? null : coverage(l);
    const outside = targets.filter((f) => {
      const c = representativePoint(f.geometry);
      if (circles) return !circles.some(([x, y, rr]) => haversine(c, [x, y]) <= rr);
      return box ? !inside(c, box) : false;
    }).map((f) => f.properties.id);
    if (outside.length) {
      why.push(`${outside.join(', ')} ${outside.length > 1 ? 'are' : 'is'} outside the area "${l}" was fetched for (added or moved after it)`);
      const a = fc?.uw?.args || {};
      refetch ||= fc?.uw?.cmd === 'places' && a.kinds ? `uw places ${site.rel} --layer ${l} --kinds ${a.kinds} --around ${layer} --radius ${a.radius ?? 1000} --force` : `re-run the ${fc?.uw?.cmd || 'command'} that made "${l}" so it covers every ${layer} feature`;
    }
    const cl = configLayer(site, l);
    const res = why.length ? { layer: l, reason: why.join('; '), refetch, outside, caveat: `${l.length <= 3 ? l.toUpperCase() : (cl?.title || titleCase(l))} data partial` } : null;
    partialInfo.set(l, res);
    return res;
  };
  // where a layer's places came from, for metrics.json "source"
  const sourceOf = (l) => {
    try {
      const fc = loadLayer(site, l);
      if (fc.source?.label) return fc.source.label;
      if (fc.uw?.args?.via) return `${fc.uw.args.via_label || fc.uw.args.via} (Overpass could not answer)`;
    } catch {}
    return null;
  };
  const srcLayer = {}; // metric key → source layer id
  for (const cl of counts) {
    if (!present(cl)) continue;
    const pts = pointsOf(cl);
    const cov = coverage(cl);
    for (const f of targets) {
      const c = representativePoint(f.geometry);
      if (cov && !inside(c, cov)) warnings.push(`${f.properties.id} is outside the area "${cl}" was fetched for, so its ${key(cl)} count is too low. Re-fetch ${cl} with a --bbox that covers every ${layer} feature.`);
      const polys = iso ? iso.filter((p) => String(p.properties.for) === String(f.properties.id)) : [];
      if (iso && !polys.length) {
        warnings.push(`${f.properties.id}: no isochrone in "${isoLayer}" (for = "${f.properties.id}"); ${key(cl)} counts left empty. Re-run isochrone for this layer.`);
        continue;
      }
      if (polys.length) {
        for (const p of polys) {
          const k = `${key(cl)}_${p.properties.minutes ?? 'iso'}min`;
          f.properties[k] = pts.filter((x) => x.f !== f && pointInPolygonGeom(x.c, p.geometry)).length;
          added.add(k); srcLayer[k] = cl;
        }
      } else {
        const k = `${key(cl)}_${radius}m`;
        f.properties[k] = pts.filter((x) => x.f !== f && haversine(c, x.c) <= radius).length;
        added.add(k); srcLayer[k] = cl;
      }
    }
  }
  const edgeScale = {};
  for (const nl of nearest) {
    if (!present(nl)) continue;
    const pts = doorsOf(nl);
    const viaDoors = pts.some((x) => x.entrance != null);
    if (!pts.length) { warnings.push(`layer "${nl}" is empty; nearest_${key(nl)}_m not computed`); continue; }
    // features that stand for an area: their polygon (from the data, else the OSM way/relation outline by id)
    const shapes = new Map();
    for (const x of pts) {
      const g = x.f.geometry;
      if (/Polygon/.test(g.type)) shapes.set(x, g);
      else if (/^osm-[wr]\d+$/.test(String(x.f.properties?.osm_id || ''))) {
        try { const sg = await osmOutline(x.f.properties.osm_id); if (sg) shapes.set(x, sg); else warnings.push(`${nl}:${x.f.properties.id}: no outline for ${x.f.properties.osm_id}; measured to its point`); }
        catch (e) { warnings.push(`${nl}:${x.f.properties.id}: outline of ${x.f.properties.osm_id} unavailable (${e.message}); measured to its point`); }
      }
    }
    const distTo = (c, x) => {
      const g = shapes.get(x);
      if (!g) return { d: haversine(c, x.c), inside: false };
      if (pointInPolygonGeom(c, g)) return { d: 0, inside: true };
      const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
      let d = Infinity; for (const r of rings) { const n = nearestOnLine(c, r); if (n && n.dist_m < d) d = n.dist_m; }
      return { d, inside: false };
    };
    edgeScale[key(nl)] = shapes.size ? 'straight line to the edge (0 = inside)' : viaDoors ? 'straight line to the nearest entrance' : 'straight line';
    for (const f of targets) {
      const c = representativePoint(f.geometry);
      let best = null, bd = Infinity, bin = false;
      for (const x of pts) { if (x.f === f) continue; const { d, inside } = distTo(c, x); if (d < bd) { bd = d; best = x; bin = inside; } }
      for (const k of [`nearest_${key(nl)}_m`, `nearest_${key(nl)}_name`, `nearest_${key(nl)}_id`, `nearest_${key(nl)}_inside`, `nearest_${key(nl)}_hours`, `nearest_${key(nl)}_kind`]) delete f.properties[k];
      if (!best) continue;
      f.properties[`nearest_${key(nl)}_m`] = Math.round(bd);
      f.properties[`nearest_${key(nl)}_name`] = best.f.properties?.name_en || best.f.properties?.name || best.f.properties?.id;
      if (best.f.properties?.id != null) f.properties[`nearest_${key(nl)}_id`] = best.f.properties.id;
      if (shapes.has(best)) f.properties[`nearest_${key(nl)}_inside`] = bin;
      // its hours when it has them (a night market's permitted hours): the card says when it is there
      const bp = best.f.properties || {};
      if (typeof bp.time_from === 'number' && typeof bp.time_to === 'number') f.properties[`nearest_${key(nl)}_hours`] = `${hhmm(bp.time_from)}–${hhmm(bp.time_to)}`;
      if (typeof bp.kind === 'string') f.properties[`nearest_${key(nl)}_kind`] = bp.kind;
      added.add(`nearest_${key(nl)}_m`); added.add(`nearest_${key(nl)}_name`);
      layerOf[`nearest_${key(nl)}_m`] = { layer: nl, id_key: `nearest_${key(nl)}_id` }; srcLayer[`nearest_${key(nl)}_m`] = nl;
    }
  }
  if (args.feel || args['feel-within']) {
    const gridId = args.grid || site.config?.vibe?.grid || (site.config?.layers || []).find((l) => l?.type === 'grid')?.id || 'feel';
    const gp = layerPath(site, gridId);
    if (!exists(gp)) throw skipLine(`enrich: no feel grid yet (${path.relative(site.dir, gp)}; feel was skipped or not run); the map works without it. Run uw feel ${site.rel} --around ${layer} first.`);
    const grid = (readJSON(gp).features || []).filter((g) => !g.properties?.water); // water cells carry no estimate
    if (args.feel) {
      let outside = 0;
      for (const f of targets) {
        const c = representativePoint(f.geometry);
        const cell = grid.find((g) => pointInPolygonGeom(c, g.geometry));
        // a feature outside a newly built grid loses the old grid's values (never keeps a stale estimate)
        if (!cell) { outside++; for (const k of FEEL_KEYS) delete f.properties[k]; continue; }
        for (const k of FEEL_KEYS) if (cell.properties[k] != null) { f.properties[k] = cell.properties[k]; added.add(k); }
      }
      if (outside) warnings.push(`${outside} feature(s) are outside the feel grid (their old feel values were removed); re-run feel with a bbox that covers them.`);
    }
    if (args['feel-within']) {
      const W = args['feel-within'];
      if (!exists(layerPath(site, W))) throw skipLine(`enrich: no "${W}" walk areas yet (isochrone was skipped or not run); the map works without it. Run uw isochrone ${site.rel} --layer ${W} --from layer:${layer} first.`);
      const polys = loadLayer(site, W).features.filter((p) => p?.properties?.for != null && /Polygon/.test(p.geometry?.type || ''));
      if (!polys.length) throw new UserError(`layer "${W}" has no polygons with a "for" property. Make them with: uw.mjs isochrone ${site.rel} --layer ${W} --from layer:${layer}`);
      const centres = grid.map((g) => ({ g, c: representativePoint(g.geometry) }));
      for (const f of targets) {
        const mine = polys.filter((p) => String(p.properties.for) === String(f.properties.id));
        if (!mine.length) { warnings.push(`${f.properties.id}: no polygon in "${W}" (for = "${f.properties.id}"); area scores left empty`); continue; }
        const poly = mine.reduce((a, b) => ((b.properties.minutes || 0) > (a.properties.minutes || 0) ? b : a));
        const cells = centres.filter((x) => pointInPolygonGeom(x.c, poly.geometry)).map((x) => x.g.properties);
        if (cells.length < 3) { warnings.push(`${f.properties.id}: only ${cells.length} feel cell(s) inside its "${W}" polygon; is the grid covering it?`); if (!cells.length) continue; }
        const mean = (k) => { const v = cells.map((p) => p[k]).filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
        for (const k of ['calm_day', 'calm_night', 'lively_day', 'lively_night', 'green', 'amenities']) {
          const m = mean(k); if (m == null) continue;
          f.properties[`${k}_area`] = Math.round(m * 100) / 100; added.add(`${k}_area`);
        }
        const nn = mean('noise_night_db'); if (nn != null) { f.properties.noise_night_db_area = Math.round(nn); added.add('noise_night_db_area'); }
        f.properties.area_cells = cells.length; added.add('area_cells');
      }
    }
  }
  if (args['route-to'] && present(args['route-to'])) {
    const R = args['route-to'], mode = { walk: 'foot', foot: 'foot', bike: 'bike', cycling: 'bike' }[args.mode || 'foot'];
    if (!mode) throw new UsageError('--mode must be foot or bike');
    const pts = doorsOf(R);
    if (!pts.length) throw new UserError(`layer "${R}" is empty`);
    const word = mode === 'bike' ? 'ride' : 'walk', kk = key(R);
    let routed = 0;
    for (const [n, f] of targets.entries()) {
      const c = representativePoint(f.geometry);
      // the nearest 4 places by straight line (with entrances: up to 2 doors each, 6 doors in all)
      const per = new Map();
      const near = pts.filter((x) => x.f !== f).map((x) => ({ ...x, d: haversine(c, x.c) })).sort((a, b) => a.d - b.d)
        .filter((x) => { const n = per.get(x.f) || 0; if (n >= (x.entrance != null ? 2 : 1) || (!n && per.size >= 4)) return false; per.set(x.f, n + 1); return true; }).slice(0, 6);
      if (!near.length) continue;
      if (n) await sleep(400);
      let t;
      try { t = await walkTable(c, near.map((x) => x.c), { mode: mode === 'bike' ? 'bike' : 'foot' }); } catch (e) {
        if (!isSkip(e)) throw e;
        // out of time or routing unavailable: keep what is measured (counts, nearest, the routes done so far) and say what is missing
        skipped = e; skipped.missing = `${word}_min_${kk} missing for ${targets.length - routed} of ${targets.length}${nearest.includes(R) ? ` (nearest_${kk}_m, straight line, stands in)` : ''}`;
        // times for only some options: never compared as if complete ("longest walk" may be one never routed)
        routedPartial = { keys: [`${word}_min_${kk}`, `${word}_km_${kk}`], reason: `${skipped.missing}: routing stopped (${e.message})`, caveat: `${word === 'ride' ? 'Ride' : 'Walk'} times partial`,
          refetch: `uw enrich ${site.rel} --layer ${layer} --route-to ${R}${args.mode ? ` --mode ${args.mode}` : ''}` };
        break;
      }
      routed++;
      if (t.code !== 'Ok') { warnings.push(`${f.properties.id}: OSRM table said ${t.code}`); continue; }
      let best = -1;
      t.durations[0].forEach((d, j) => { if (j && d != null && (best < 0 || d < t.durations[0][best])) best = j; });
      if (best < 0) continue;
      const to = near[best - 1].f.properties;
      f.properties[`${word}_min_${kk}`] = Math.max(1, Math.round(t.durations[0][best] / 60));
      f.properties[`${word}_km_${kk}`] = Math.round((t.distances?.[0]?.[best] ?? near[best - 1].d) / 10) / 100;
      f.properties[`${word}_min_${kk}_name`] = to.name_en || to.name || to.id;
      f.properties[`${word}_min_${kk}_id`] = to.id;
      f.properties[`${word}_id_${kk}`] = to.id; // v0.2 name (metrics.json id_key); _min_<layer>_id kept for v0 sites
      layerOf[`${word}_min_${kk}`] = { layer: R, id_key: `${word}_id_${kk}` };
      layerOf[`${word}_km_${kk}`] = { layer: R, id_key: `${word}_id_${kk}` };
      srcLayer[`${word}_min_${kk}`] = R; srcLayer[`${word}_km_${kk}`] = R;
      for (const k of [`${word}_min_${kk}`, `${word}_km_${kk}`, `${word}_min_${kk}_name`]) added.add(k);
    }
  }

  if (!added.size && missingLayers.length && !skipped) {
    // nothing to measure against yet: the map is fine without these numbers (exit 4 = skipped, go on)
    throw skipLine(`enrich: ${missingLayers.map((l) => `"${l}"`).join(', ')} ${missingLayers.length > 1 ? 'have' : 'has'} no data yet (the places step was skipped); the map works without it. Retry that places step, then this enrich.`);
  }
  writeGeoJSON(layerPath(site, layer), fc);
  // data/metrics.json: label, unit, basis, source and anchors per written metric (engine + validate read it)
  const isoMin = iso ? Math.max(...iso.map((p) => p.properties.minutes || 0)) || null : null;
  const entries = {};
  const PARTIAL_KEYS = ['partial', 'partial_reason', 'partial_refetch', 'caveat'];
  const partialLines = new Map();
  for (const k of added) {
    const e = metricEntry(k, { isoLayer, isoMin, radius, mode: args.mode, edge: edgeScale });
    if (!e) continue;
    entries[k] = { ...e, ...(layerOf[k] || {}) };
    const L = srcLayer[k];
    // times for only some options: partial, whatever their target layer says
    if (routedPartial?.keys.includes(k)) {
      Object.assign(entries[k], { partial: true, partial_reason: routedPartial.reason, partial_refetch: routedPartial.refetch, caveat: routedPartial.caveat, confidence: 'low' });
      if (L) { const src = sourceOf(L); if (src) entries[k].source = `${e.source}; ${L}: ${src}`; }
      continue;
    }
    if (!L) continue;
    const src = sourceOf(L);
    if (src) entries[k].source = /^(walk|ride)_/.test(k) ? `${e.source}; ${L}: ${src}` : src;
    const P = partialOf(L);
    if (P) {
      Object.assign(entries[k], { partial: true, partial_reason: P.reason, partial_refetch: P.refetch || undefined, caveat: P.caveat, confidence: 'low' });
      if (!/_km_/.test(k)) partialLines.set(L, [...(partialLines.get(L) || []), k]);
    } else entries[k]._unset = [...(e._unset || []), ...PARTIAL_KEYS];
  }
  if (Object.keys(entries).length) mergeMetrics(site.dir, entries, 'enrich');
  if (skipped) {
    // the skip line (exit 4) says what was kept; the file and metrics.json above are complete for what is in them
    for (const w of [...new Set(warnings)]) out.warn(w);
    const k = [...added].filter((x) => !/_name$/.test(x));
    skipped.kept = `${k.length ? k.join(', ') : 'nothing new'} in ${layer} (${skipped.missing})`;
    if (routedPartial && added.has(routedPartial.keys[0])) console.error(partialLine(`${routedPartial.keys[0]} in ${layer}`, routedPartial.reason, `the verdict says "${routedPartial.caveat}" and no shortest/longest; later: ${routedPartial.refetch}`));
    throw skipped;
  }
  for (const w of [...new Set(warnings)]) out.warn(w);
  const partialOut = [...partialLines].map(([L, ks]) => ({ layer: L, metrics: ks, ...partialOf(L) }));
  const keys = [...added];
  const numKeys = keys.filter((k) => !k.endsWith('_name') && k !== 'area_cells');
  const rows = targets.map((f) => `  ${f.properties.id}: ` + numKeys.map((k) => `${k}=${f.properties[k] ?? '—'}`).join(' '));
  const compare = numKeys.map((k) => ({ key: k, label: label(k), ...(k.endsWith('_m') ? { unit: 'm', better: 'lower' } : /noise/.test(k) ? { unit: 'dB', better: 'lower' }
    : /^(walk|ride)_min_/.test(k) ? { unit: 'min', better: 'lower' } : /^(walk|ride)_km_/.test(k) ? { unit: 'km', better: 'lower' }
    : /^lively/.test(k) ? { format: 'pct' } : FEEL_KEYS.includes(k) || /_area$/.test(k) ? { format: 'pct', better: 'higher' } : { better: 'higher' }) }));
  out.result({ ok: true, layer, features: targets.length, metrics: keys, within: isoLayer, warnings: [...new Set(warnings)], partial: partialOut,
    suggested_compare_metrics: compare, values: Object.fromEntries(targets.map((f) => [f.properties.id, Object.fromEntries(keys.map((k) => [k, f.properties[k] ?? null]))])) }, [
    `Enriched ${targets.length} features in ${layer} with: ${keys.join(', ')}`,
    ...rows.slice(0, 12), rows.length > 12 ? `  … ${rows.length - 12} more` : null,
    `Use in config: "card": { "fields": ${JSON.stringify(numKeys.slice(0, 4))} } or "compare": { "layer": "${layer}", "metrics": [...] }`,
    ...partialOut.map((p) => `PARTIAL: ${p.metrics.join(', ')} use "${p.layer}", which is incomplete (${p.reason}). The verdict shows "${p.caveat}" and says no shortest/longest on it; say so in your reply. Fix first in Phase B: ${p.refetch || `re-fetch "${p.layer}"`}, then this enrich again.`),
  ]);
}

// metrics.json entry for a key written by enrich (basis + source + anchors per ENGINE-SPEC-v0.2 §0.4 / §1.4)
function metricEntry(k, { isoLayer, isoMin, radius, mode, edge }) {
  let m;
  const osm = 'OpenStreetMap via Overpass';
  if (/_name$|_id$/.test(k) || k === 'area_cells') return null;
  if ((m = k.match(/^(walk|ride)_min_(.+)$/))) return { label: label(k), short: m[2].length <= 3 ? m[2].toUpperCase() : nice(m[2]), unit: 'min', format: 'int', better: 'lower', basis: 'routed', confidence: 'high',
    source: `OSRM ${m[1] === 'ride' ? 'bike' : 'foot'} (FOSSGIS) on OpenStreetMap`, scale: `door → nearest ${nice(m[2])}`, good: m[1] === 'ride' ? 5 : 3, bad: 15, threshold: 2 };
  if ((m = k.match(/^(walk|ride)_km_(.+)$/))) return { label: label(k), unit: 'km', better: 'lower', basis: 'routed', confidence: 'high', source: 'OSRM (FOSSGIS) on OpenStreetMap', scale: `door → nearest ${m[2].replace(/_/g, ' ')}` };
  if ((m = k.match(/^nearest_(.+)_m$/))) return { label: label(k), unit: 'm', format: 'int', better: 'lower', basis: 'measured', confidence: 'medium', source: osm, scale: edge?.[m[1]] || 'straight line', good: 200, bad: 1200, threshold: 100 };
  if ((m = k.match(/^(.+)_(\d+)min$/))) return { label: label(k), unit: 'places', format: 'int', better: 'higher', basis: 'counted', confidence: 'medium', source: osm + (isoLayer ? ` inside the ${m[2]}-min walk (Valhalla, layer ${isoLayer})` : ''),
    scale: `inside the ${m[2]}-min walk`, cap: 20, good: 20, bad: 0, threshold: 3, layer: m[1].replace(/_/g, '-') };
  if ((m = k.match(/^(.+)_(\d+)m$/))) return { label: label(k), unit: 'places', format: 'int', better: 'higher', basis: 'counted', confidence: 'medium', source: osm, scale: `within ${m[2]} m (straight line)`, cap: 20, good: 20, bad: 0, threshold: 3 };
  if (/^noise_.*db/.test(k)) return { label: label(k), unit: 'dB', format: 'int', better: 'lower', basis: 'estimated', confidence: 'low', source: 'uw feel noise model (OpenStreetMap roads, rail, airports)', scale: /_area$/.test(k) ? 'mean over the walk area' : 'the 200 m square at the door', good: 55, bad: 70, threshold: 3 };
  // no fixed good/bad: the engine ranks these against this map's own grid (a percentile), so they never saturate
  if (FEEL_KEYS.includes(k) || /_area$/.test(k)) return { label: label(k), format: 'pct', better: 'higher', basis: 'estimated', confidence: 'low', source: 'uw feel (OpenStreetMap)',
    scale: /_area$/.test(k) ? `mean over the ${isoMin || 10}-min walk` : 'the 200 m square at the door', threshold: 0.05, layer: 'feel', _unset: ['good', 'bad'] };
  return { label: label(k), basis: 'counted', source: osm };
}

function label(k) {
  let m;
  if ((m = k.match(/^nearest_(.+)_m$/))) return `To ${m[1].replace(/_/g, ' ')}`;
  if ((m = k.match(/^(.+)_(\d+)min$/))) return `${cap(m[1].replace(/_/g, ' '))} ≤${m[2]} min`;
  if ((m = k.match(/^(.+)_(\d+)m$/))) return `${cap(m[1].replace(/_/g, ' '))} ≤${m[2]} m`;
  if ((m = k.match(/^(walk|ride)_min_(.+)$/))) return `${m[1] === 'ride' ? 'Ride' : 'Walk'} to ${nice(m[2])}`;
  if ((m = k.match(/^(walk|ride)_km_(.+)$/))) return `${m[1] === 'ride' ? 'Ride' : 'Walk'} to ${nice(m[2])} (km)`;
  if ((m = k.match(/^(.+)_area$/))) return `${label(m[1]).replace(' (est.)', '')}, walk area (est.)`;
  return { calm_day: 'Calm by day (est.)', calm_night: 'Calm at night (est.)', lively_day: 'Lively by day (est.)', lively_night: 'Lively at night (est.)',
    green: 'Green (est.)', amenities: 'Daily needs (est.)', noise_day_db: 'Noise by day (est.)', noise_night_db: 'Noise at night (est.)' }[k] || k;
}
const nice = (id) => (id.length <= 3 ? id.toUpperCase() : id.replace(/_/g, ' '));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The outline of an OSM way / relation ("osm-r17080648") as a GeoJSON (Multi)Polygon, or null. */
const outlineCache = new Map();
async function osmOutline(osmId) {
  if (outlineCache.has(osmId)) return outlineCache.get(osmId);
  const [, t, n] = /^osm-([wr])(\d+)$/.exec(osmId);
  const data = await overpass(`[out:json][timeout:40];${t === 'w' ? 'way' : 'relation'}(${n});out geom qt;`, { timeoutS: 40 });
  const e = (data.elements || [])[0];
  let g = null;
  if (e?.type === 'way' && e.geometry?.length >= 4) g = { type: 'Polygon', coordinates: [e.geometry.map((p) => [p.lon, p.lat])] };
  else if (e?.type === 'relation') {
    const outer = assembleRings((e.members || []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry.map((p) => [p.lon, p.lat])));
    if (outer.length) g = outer.length === 1 ? { type: 'Polygon', coordinates: [outer[0]] } : { type: 'MultiPolygon', coordinates: outer.map((r) => [r]) };
  }
  outlineCache.set(osmId, g);
  return g;
}

const hhmm = (h) => { const x = ((h % 24) + 24) % 24; return `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.round((x % 1) * 60)).padStart(2, '0')}`; };
