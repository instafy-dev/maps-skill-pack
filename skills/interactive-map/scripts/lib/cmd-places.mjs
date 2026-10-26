// `places`: Overpass → points with normalised properties.
import { parseArgs, makeOut, parseLngLat, parseBBox, parseList, bboxAround, bboxAreaKm2, haversine, round6, pointInPolygonGeom, UsageError } from './util.mjs';
import { placesSearch } from './osm-places.mjs';
import { openSite, checkLayerId, writeOwnedLayer, assertOwned, layerHint, registerLayer, viewBounds, layerBBox, loadLayer, setLayerPartial, addAttribution } from './site.mjs';
import { makeAdapterCtx } from './cmd-adapter.mjs';
import { KINDS, resolveKind, classify, tagFilter, esc, osmId, emojiFor } from './kinds.mjs';
import { adapterFor } from '../adapters/lib/areas.mjs';


export const help = `places <dir> --layer <id> (--kinds cafe,gym,… | --tag k=v …) [--around <layerId> [--radius m] | --near lng,lat --radius m | --bbox w,s,e,n]
       [--within <areasLayer>] [--name-match regex] [--no-brands] [--include-unnamed] [--kind label] [--emoji ☕] [--limit N]
       [--append] [--force] [--force-large] [--source osm] [--json]
  Overpass → data/<layer>.geojson points (ways/relations use their centre). Without --near/--bbox/--around the config's
  view.bounds is used.
  --around hotels   within --radius (default 1000 m) of any feature of layer "hotels" (a real circle around each point;
                    for line/area layers: their bounding box grown by --radius).
  --within walk     keep only places inside the polygons of an areas layer (e.g. the 10-min walk isochrones).
  --kinds and --tag combine with AND: --kinds cafe --tag cuisine=coffee_shop = cafés tagged coffee_shop.
  --tag forms: k=v, k~regex, k!=v, k!~regex, !k (key absent), k=* (repeatable; all must match).
  --no-brands       drop chain branches (anything with a brand tag): "independent cafés".
  --name-match re   matches name, name:en, int_name, alt_name, old_name, official_name.
  --append          add to the layer's file instead of replacing it (e.g. one call per town; same ids are merged).
  Props: id (osm-n123…), name, name_en, kind, emoji, opening_hours, website, url, cuisine, brand, address.
  Simple opening_hours ("Mo-Su 17:00-01:00") also become time_from/time_to, so with the time slider on a place shows only
  while open (night markets glow at night). --ignore-hours skips that. Area cap 60 km² unless --force-large.
  Overpass unavailable: kinds with a reverse-search tag (${Object.keys(KINDS).filter((k) => KINDS[k].tags).join(', ')}) come from the
  places chain's next provider (lookup-providers.json; names + positions, ≤ 50 per point; "via": its id); 15 s of the
  time limit is kept back for it. Others exit 4 (unavailable: the area is not empty, it could not be asked).
  Where a metro adapter covers the area (uw adapter list --at <lng,lat>), mrt_station comes from the operator's own open data (e.g. tw-metro: every station + its entrances,
  OGDL credit added), not OpenStreetMap; --source osm skips that. Elsewhere, or when it is unavailable: OpenStreetMap.
  Incomplete results (a fallback provider, a --limit cut) are marked "partial" in the file and the config layer;
  enrich and the verdict carry the caveat. A later complete run clears it.
  Kinds: ${Object.keys(KINDS).join(', ')}
  Notes: "cafe" leaves out cannabis coffeeshops; "coffee" also leaves out bubble tea, tea and juice counters.
  "park" = public parks + named gardens (unnamed ones dropped).`;

const NAME_KEYS = 'name|name:en|int_name|alt_name|old_name|official_name|short_name';
const PRIMARY = ['amenity', 'shop', 'tourism', 'leisure', 'railway', 'historic', 'natural', 'office', 'craft', 'healthcare', 'sport'];

export async function run(argv) {
  const args = parseArgs(argv, { layer: 'string', kinds: 'string', tag: 'multi', near: 'string', radius: 'number', bbox: 'string',
    'name-match': 'string', limit: 'number', force: 'bool', 'force-large': 'bool', around: 'string', within: 'string', 'ignore-hours': 'bool',
    'no-brands': 'bool', 'include-unnamed': 'bool', kind: 'string', emoji: 'string', append: 'bool', source: 'string' }, { positionals: [1, 1], command: 'places' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  assertOwned(site, layer, 'places', args.force || args.append);

  // What
  const kinds = [];
  for (const k of parseList(args.kinds)) {
    const r = resolveKind(k);
    if (!r) throw new UsageError(`unknown kind "${k}". Known kinds: ${Object.keys(KINDS).join(', ')}. For anything else use --tag key=value (e.g. --tag amenity=library).`);
    if (!kinds.includes(r)) kinds.push(r);
  }
  const tagFilters = args.tag.map((t) => {
    const f = tagFilter(t);
    if (!f) throw new UsageError(`--tag "${t}" is not understood. Use key=value, key~regex, key!=value, key!~regex, !key or key=*`);
    return f;
  });
  if (args['no-brands']) tagFilters.push('[!"brand"]', '[!"brand:wikidata"]');
  if (!kinds.length && !tagFilters.length) throw new UsageError('give --kinds (e.g. --kinds cafe,bakery) or --tag key=value');

  // Where: one or more Overpass area filters
  let areas = [], bbox, center, aroundPts = null, withinPolys = null;
  const r = args.radius;
  if (r !== undefined && !args.near && !args.around) throw new UsageError('--radius only works together with --near or --around');
  if (r !== undefined && (r < 0 || r > 20000)) throw new UsageError('--radius must be between 0 and 20000 metres');
  if (args.within) {
    const fc = loadLayer(site, args.within);
    withinPolys = fc.features.filter((f) => /Polygon/.test(f?.geometry?.type || ''));
    if (!withinPolys.length) throw new UsageError(`--within ${args.within}: that layer has no polygons (make them with: uw.mjs isochrone ${site.rel} --layer ${args.within} --from layer:<points>)`);
  }
  if (args.near) {
    center = parseLngLat(args.near, 'near');
    const rr = r ?? 800;
    if (rr <= 0) throw new UsageError('--radius must be > 0 with --near');
    areas = [`(around:${Math.round(rr)},${center[1]},${center[0]})`];
    bbox = bboxAround(center, rr);
  } else if (args.around) {
    const rr = r ?? 1000;
    const fc = loadLayer(site, args.around);
    const pts = fc.features.filter((f) => f?.geometry?.type === 'Point').map((f) => f.geometry.coordinates);
    bbox = layerBBox(site, args.around, rr);
    if (pts.length && pts.length === fc.features.length && pts.length <= 40 && rr > 0) {
      // a real circle around each point (not one big box): spread-out stops stay small, and "--radius 1000" means 1000 m
      aroundPts = pts;
      areas = pts.map((c) => `(around:${Math.round(rr)},${c[1]},${c[0]})`);
      out.log(`Within ${rr} m of the ${pts.length} feature(s) of "${args.around}"`);
    } else {
      areas = [`(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})`];
      out.log(`Around layer "${args.around}" + ${rr} m (bounding box): ${bbox.join(',')}`);
    }
  } else if (args.bbox) {
    bbox = parseBBox(args.bbox);
    areas = [`(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})`];
  } else if (withinPolys) {
    bbox = layerBBox(site, args.within, 0);
    areas = [`(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})`];
    out.log(`Inside the polygons of "${args.within}" (box ${bbox.join(',')})`);
  } else {
    bbox = viewBounds(site);
    if (!bbox) throw new UsageError('give --near lng,lat --radius m, --around <layer>, --within <areasLayer> or --bbox w,s,e,n (map.config.json has no view.bounds to fall back on)');
    areas = [`(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})`];
    out.log(`Using view.bounds from map.config.json: ${bbox.join(',')}`);
  }
  const km2 = aroundPts ? aroundPts.length * Math.PI * ((r ?? 1000) / 1000) ** 2 : bboxAreaKm2(bbox);
  if (km2 > 60 && !args['force-large'])
    throw new UsageError(`area is ${km2.toFixed(1)} km² (> 60 km²). Narrow it (smaller --radius/--bbox) or pass --force-large if you really need it.`);
  center ||= [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  if (args.source && !['osm', 'auto'].includes(args.source)) throw new UsageError('--source must be osm (OpenStreetMap only) or auto');

  // Taiwan: metro stations from the operator's open data (complete, no Overpass); the other kinds still from OSM
  let metro = null;
  const metroAdapter = kinds.includes('mrt_station') && args.source !== 'osm' && !tagFilters.length ? adapterFor('metro-stations', center) : null;
  if (metroAdapter) {
    metro = await metroStations(metroAdapter.name, { circles: aroundPts || (args.near ? [center] : null), radiusM: aroundPts ? (r ?? 1000) : (r ?? 800), bbox, center, out });
    if (metro && args['name-match']) {
      const re = new RegExp(args['name-match'], 'i');
      metro.feats = metro.feats.filter((f) => re.test(f.properties.name) || re.test(f.properties.name_en || ''));
    }
  }
  const osmKinds = metro ? kinds.filter((k) => k !== 'mrt_station') : kinds;

  const nameF = args['name-match'] ? `[~"^(${NAME_KEYS})$"~"${esc(args['name-match'])}",i]` : '';
  const tags = tagFilters.join('');
  const stmts = [];
  for (const area of areas) {
    for (const k of osmKinds) for (const sel of KINDS[k].sel) stmts.push(`  nwr${sel}${tags}${nameF}${area};`);
    if (!kinds.length) stmts.push(`  nwr${tags}${nameF}${area};`);
  }
  const q = `[out:json][timeout:60];\n(\n${stmts.join('\n')}\n);\nout center tags;`;
  if (stmts.length) out.log(`Querying Overpass for ${osmKinds.length ? osmKinds.join(', ') : ''}${args.tag.length ? (kinds.length ? ' with ' : '') + args.tag.join(' ') : ''}${args['no-brands'] ? ' (no chains)' : ''} (${km2.toFixed(1)} km²)…`);
  // The "places" chain (lookup-providers.json): Overpass first; while it cannot answer, kinds with a reverse-search tag
  // (stations, cafés…) still come back from the next provider (names + positions, ≤ 50 per point, nearest first: the
  // layer is marked PARTIAL); 15 s of the limit is kept back for it. Not with --tag / --name-match / --no-brands (a
  // reverse search cannot filter by those) or a box without centre points.
  const fbPts = aroundPts || (args.near ? [center] : null);
  const fbR = aroundPts ? (r ?? 1000) : (r ?? 800);
  const canFallback = !!fbPts && fbR > 0 && osmKinds.length && osmKinds.every((k) => KINDS[k].tags) && !tagFilters.length && !nameF && fbPts.length <= 12;
  let data = { elements: [] }, via = stmts.length ? 'overpass' : (metro?.adapter || 'overpass'), fbNotes = [], fallback = null;
  if (stmts.length) {
    const got = await placesSearch({ query: q, timeoutS: 60, reserveMs: 15000,
      ...(canFallback ? { reverse: { points: fbPts, radiusM: fbR, tags: osmKinds.flatMap((k) => KINDS[k].tags.map((tag) => ({ tag, kind: k }))) } } : {}) });
    data = { elements: got.elements, _cached: got.cached };
    if (got.status === 'partial') {
      fallback = got; fbNotes = got.notes; via = got.provider;
      out.warn(`${got.fallbackFor.join('; ') || 'Overpass could not answer'}; ${got.label} answered instead (names and positions only, no opening hours, at most 50 per point, and it can miss places${osmKinds.includes('mrt_station') ? '; it cannot tell metro from train stations, so nearby rail stations count as "MRT"' : ''}). The layer is marked partial.`);
    }
  }

  let feats = [];
  const seen = new Set();
  let droppedUnnamed = 0, droppedOutside = 0;
  for (const el of data.elements || []) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const id = osmId(el);
    if (seen.has(id)) continue;
    seen.add(id);
    const t = el.tags || {};
    const c = [round6(lon), round6(lat)];
    // the query used boxes / circles around centres; keep what is really inside
    if (withinPolys && !withinPolys.some((f) => pointInPolygonGeom(c, f.geometry))) { droppedOutside++; continue; }
    if (aroundPts && !aroundPts.some((a) => haversine(a, c) <= (r ?? 1000) + 30)) { droppedOutside++; continue; }
    const anyName = t.name || t['name:en'] || t.int_name || t.alt_name || t.official_name;
    const kind = el._kind || (osmKinds.length ? classify(t, osmKinds) : (args.kind || primaryValue(t) || 'place'));
    const preset = KINDS[kind];
    if (!anyName && !args['include-unnamed'] && preset?.named) { droppedUnnamed++; continue; }
    const p = { id, name: t.name || t['name:en'] || t.int_name || t.alt_name || t.brand || t.operator || preset?.label || tagLabel(t) };
    if (t['name:en'] && t['name:en'] !== p.name) p.name_en = t['name:en'];
    else if (!t['name:en'] && t.int_name && t.int_name !== p.name) p.name_en = t.int_name;
    p.kind = kind;
    p.emoji = args.emoji || preset?.emoji || emojiFor(kind);
    if (t.opening_hours) {
      p.opening_hours = t.opening_hours;
      const win = args['ignore-hours'] ? null : hoursWindow(t.opening_hours);
      if (win) { p.time_from = win[0]; p.time_to = win[1]; }
    }
    const web = t.website || t['contact:website'] || t.url;
    if (web) { p.website = web; p.url = web; }
    if (t.cuisine) p.cuisine = t.cuisine.replace(/_/g, ' ').replace(/;/g, ', ');
    if (t.brand) p.brand = t.brand;
    const addr = [t['addr:street'] || t['addr:place'], t['addr:housenumber']].filter(Boolean).join(' ');
    if (addr) p.address = addr;
    if (!anyName) p.unnamed = true;
    p.source = fallback ? fallback.label : 'OpenStreetMap';
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: p, _t: t });
  }
  // Dedupe kinds that are mapped several times (stations, night markets): same name within 400 m (stations 700 m);
  // night markets also by distance alone (廣州街觀光夜市 vs 廣州街夜市, 5 m apart).
  const dd = [];
  for (const f of feats) {
    const K = KINDS[f.properties.kind];
    if (K?.dedupe && !f.properties.unnamed) {
      const lim = K.dedupe === true ? 400 : K.dedupe;
      const dup = dd.find((g) => g.properties.kind === f.properties.kind && (
        (sameName(g.properties.name, f.properties.name) && haversine(g.geometry.coordinates, f.geometry.coordinates) < lim) ||
        (K.dedupeAnyName && haversine(g.geometry.coordinates, f.geometry.coordinates) < K.dedupeAnyName)));
      if (dup) { if (!dup.properties.name_en && f.properties.name_en) dup.properties.name_en = f.properties.name_en; continue; }
    }
    dd.push(f);
  }
  const removedDupes = feats.length - dd.length;
  feats = dd;
  if (metro) feats.push(...metro.feats);
  for (const f of feats) f.properties.distance_m = Math.round(haversine(center, f.geometry.coordinates));
  feats.sort((a, b) => (a.properties.unnamed ? 1 : 0) - (b.properties.unnamed ? 1 : 0) || a.properties.distance_m - b.properties.distance_m);
  const total = feats.length;
  const limit = args.limit ?? 300;
  if (feats.length > limit) feats = feats.slice(0, limit);
  // incomplete data is said where it is used: the file, the config layer, then enrich's metrics and the verdict
  const partialWhy = [];
  if (fallback) partialWhy.push(`Overpass could not answer, so ${osmKinds.join(', ')} came from ${fallback.label} (names and positions only; it can miss places${fbNotes.length ? `; ${fbNotes.join('; ')}` : ''})`);
  if (total > feats.length) partialWhy.push(`kept the nearest ${feats.length} of ${total} (--limit)`);
  for (const f of feats) { delete f._t; if (!args.near) delete f.properties.distance_m; }

  if (!feats.length && !metro) {
    out.warn(`Overpass returned no matching places. Check the area (lng,lat order!) and kinds; try a larger --radius.`);
  }
  let all = feats, appended = 0;
  if (args.append) {
    const prev = loadLayer(site, layer, { required: false });
    if (prev) {
      const ids = new Set(feats.map((f) => f.properties.id));
      const keep = prev.features.filter((f) => !ids.has(f?.properties?.id));
      appended = keep.length;
      all = keep.concat(feats);
    }
  }
  const callArgs = { kinds: kinds.join(',') || undefined, tag: args.tag.length ? args.tag : undefined, near: args.near, radius: args.near || args.around ? (r ?? (args.near ? 800 : 1000)) : undefined,
    around: args.around, within: args.within, bbox: args.near ? undefined : bbox.join(','), ...(fallback ? { via: fallback.provider, via_label: fallback.label } : {}), ...(metro ? { source: metro.adapter } : {}) };
  // appending to a partial file keeps it partial (the earlier part is still incomplete)
  let prevPartial = null;
  if (args.append) { try { prevPartial = loadLayer(site, layer, { required: false })?.uw?.partial || null; } catch {} }
  const refetch = `${retryHint(argv.filter((a) => a !== '--append'))}${argv.includes('--force') ? '' : ' --force'}`;
  const partial = partialWhy.length ? { reason: partialWhy.join('; '), refetch } : prevPartial;
  const coverage = aroundPts ? { circles: aroundPts.map((c) => [c[0], c[1], r ?? 1000]) } : args.near ? { circles: [[center[0], center[1], r ?? 800]] } : null;
  const fcOut = { type: 'FeatureCollection', ...(metro && !osmKinds.length && !tagFilters.length ? metro.fileFields : {}), features: all };
  const w = writeOwnedLayer(site, layer, fcOut, {
    cmd: 'places', args: args.append && appended ? { ...callArgs, appended: true } : callArgs, force: args.force || args.append, out, partial, coverage: args.append && appended ? null : coverage });
  const byKind = {};
  for (const f of feats) byKind[f.properties.kind] = (byKind[f.properties.kind] || 0) + 1;
  // many points: small badges + clustering keep a phone map readable
  const style = { ...(kinds.length === 1 ? { emoji: KINDS[kinds[0]].emoji } : args.emoji ? { emoji: args.emoji } : {}), ...(all.length > 40 ? { size: 's' } : {}) };
  const kindTitle = kinds.length === 1 && KINDS[kinds[0]]?.label ? KINDS[kinds[0]].label.replace(/(?<!s)$/, 's').replace(/ys$/, 'ies').replace(/^Nightlifes$/, 'Nightlife') : null;
  const hint = layerHint(site, layer, 'points', { ...(kindTitle ? { title: kindTitle } : {}), ...(Object.keys(style).length ? { style } : {}), ...(all.length > 80 ? { cluster: true } : {}) });
  const registered = registerLayer(site, hint);
  const partialNote = setLayerPartial(site, layer, partial ? partial.reason : null);
  const credited = metro && addAttribution(site, metro.attribution);
  const sample = feats.slice(0, 5).map((f) => `${f.properties.name_en ? `${f.properties.name} (${f.properties.name_en})` : f.properties.name} [${layer}:${f.properties.id}]`);
  const chains = feats.filter((f) => f.properties.brand).length;
  out.result({ ok: true, layer, file: w.rel, count: feats.length, total_in_file: all.length, total_found: total, by_kind: byKind, duplicates_removed: removedDupes,
    dropped_unnamed: droppedUnnamed, dropped_outside: droppedOutside, chains, cached: !!data._cached, sample, registered_layer: registered ? hint : null,
    source: metro ? (osmKinds.length ? `${metro.adapter} + ${via}` : metro.adapter) : via, partial: partial || null }, [
    `Wrote ${feats.length} places to ${w.rel}${args.append && appended ? ` (+${appended} already there = ${all.length})` : ''}${total > feats.length ? ` (kept nearest ${feats.length} of ${total}; raise --limit for more)` : ''}: ` +
      Object.entries(byKind).map(([k, n]) => `${KINDS[k]?.emoji || ''}${k} ${n}`).join(', '),
    droppedUnnamed || droppedOutside ? `Left out: ${droppedUnnamed ? `${droppedUnnamed} unnamed` : ''}${droppedUnnamed && droppedOutside ? ', ' : ''}${droppedOutside ? `${droppedOutside} outside the area` : ''}.` : null,
    chains && !args['no-brands'] ? `${chains} of them are chain branches (brand tag); add --no-brands for independents only.` : null,
    sample.length ? `e.g. ${sample.join(' · ')}` : null,
    metro ? `🚇 ${metro.feats.length} metro station(s) from ${metro.label}: complete for ${metro.scope}, entrances included (enrich measures to the nearest one).${credited ? ' Added its credit to map.config.json attribution.' : ''}` : null,
    fallback ? `From ${fallback.label} because Overpass could not answer${fbNotes.length ? ` (${fbNotes.join('; ')})` : ''}. Good enough for a first verdict; for the full OSM data re-run later: ${retryHint(argv)}` : null,
    partial ? `PARTIAL: ${partial.reason}. Marked in ${w.rel} and the config layer; metrics made from it carry a "data partial" caveat in the verdict. Phase B: re-fetch it first: ${partial.refetch}` : null,
    partialNote && !partial ? partialNote : null,
    registered,
  ]);
}

/** Metro stations from the adapter that covers the query area (adapters/lib/areas.mjs, capability metro-stations;
 *  the adapter exports loadNetwork, covers, stationFeatures, fileFields, SOURCE_LABEL, SCOPE, ATTRIBUTION), or null
 *  when the area is outside its network or the data cannot be had (then OpenStreetMap answers as before). */
async function metroStations(adapter, { circles, radiusM, bbox, center, out }) {
  try {
    const M = await import(`../adapters/${adapter}.mjs`);
    const ctx = makeAdapterCtx({ site: null, name: adapter, log: (l) => out.log(l.trim()) });
    const net = await M.loadNetwork(ctx);
    if (!M.covers(net, circles || [center])) { out.log(`Outside the ${M.SCOPE} area: metro stations from OpenStreetMap.`); return null; }
    const feats = M.stationFeatures(net, circles ? { circles, radiusM } : { bbox });
    return { adapter, feats, label: M.SOURCE_LABEL, scope: M.SCOPE, attribution: M.ATTRIBUTION, fileFields: M.fileFields(net) };
  } catch (e) {
    if (e?.name === 'UsageError') throw e;
    out.warn(`${adapter} open data unavailable (${e.message}); metro stations from OpenStreetMap instead.`);
    return null;
  }
}

const retryHint = (argv) => `uw places ${argv.filter((a) => a !== '--json').map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a}'`)).join(' ')} --timeout 120`;

function primaryValue(t) {
  for (const k of PRIMARY) if (t[k] && t[k] !== 'yes') return t[k];
  return null;
}

function sameName(a, b) {
  const n = (s) => String(s).toLowerCase().replace(/\s|站|station|mrt|metro|捷運|觀光|tourist/g, '');
  return n(a) === n(b);
}
function tagLabel(t) {
  for (const k of ['amenity', 'shop', 'tourism', 'leisure', 'railway', 'natural', 'historic', 'office'])
    if (t[k]) return t[k].replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return 'Place';
}

// opening_hours → [from, to] hours (to may exceed 24 when it closes after midnight): the earliest opening and latest
// closing over all rules. Returns null when it is always open, closed-only, or uses anything fancier than HH:MM-HH:MM.
export function hoursWindow(oh) {
  if (typeof oh !== 'string' || !oh.trim() || /24\/7/.test(oh)) return null;
  if (/sunrise|sunset|dawn|dusk|\[|"|\+|\|\||\bweek\b/i.test(oh)) return null;
  let from = Infinity, to = -Infinity;
  for (const rule of oh.split(';')) {
    const r = rule.trim();
    if (!r || /\b(off|closed)\b/i.test(r)) continue;
    const ranges = [...r.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    if (!ranges.length) return null;
    for (const m of ranges) {
      const a = +m[1] + +m[2] / 60; let b = +m[3] + +m[4] / 60;
      if (b <= a) b += 24;
      from = Math.min(from, a); to = Math.max(to, b);
    }
  }
  if (!Number.isFinite(from) || to - from >= 23) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  return [r2(from), r2(to)];
}
