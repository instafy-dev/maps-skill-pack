// `route` (FOSSGIS OSRM), `isochrone` (FOSSGIS Valhalla), `legs` (ordered trip legs between stops).
import { parseArgs, makeOut, parseList, parseDuration, fmtMinutes, haversine, roundCoords, round6, slugify,
  simplifyLine, sleep, UsageError, UserError } from './util.mjs';
import { isSkip } from './net.mjs';
import { routeLookup, isochroneLookup, OSRM_MODES } from './route-lookups.mjs';
import { openSite, checkLayerId, writeOwnedLayer, assertOwned, layerHint, registerLayer, resolvePoint, loadLayer } from './site.mjs';
import { politeFetch, pageText } from './cmd-cite.mjs';
import { pageDurations, pageStatesDuration, describeDurations } from './durations.mjs';

export const helps = {
  route: `route <dir> --layer <id> --from <pt> --to <pt> [--via <pt> …] [--mode foot|bike|car] [--name "Day 1 walk"] [--id slug] [--append] [--json]
  <pt> is "lng,lat" or "<layer>:<featureId>" (e.g. hotels:via-loft). FOSSGIS OSRM (routing.openstreetmap.de) → a LineString
  with duration_min, distance_km, mode, from/to names. Replaces the layer file unless --append (then same id is replaced).
  Config: { "type": "route", "animate": true } gives the "Walk it ▶" animation.`,
  isochrone: `isochrone <dir> --layer <id> (--from layer:<layerId> | --from <layer>:<featureId> | --from lng,lat) [--minutes 10[,15]] [--mode foot|bike] [--json]
  Valhalla (valhalla1.openstreetmap.de) → polygons of what is reachable in N minutes, one per source feature, with props
  for (= source feature id), minutes, mode, name. Config: { "type": "areas", "linkedTo": "<layerId>" } shows the selected one.
  Max 40 source features per run (1 request each, spaced 1 s).`,
  legs: `legs <dir> --layer <id> --stops "<layer>:<id>,<layer>:<id>,…" [--modes train,hsr,bus,car,flight,ferry,walk]
       [--durations "1h45,30m,2h–3h,…" --source "THSR timetable" [--source-url https://…] [--no-source-check]] [--follow <lines layer>] [--json]
  Durations must come from the user or a published timetable (never guessed); --source names it (prop duration_source),
  --source-url links it (a "Timetable ↗" button on the leg's card; one link, or one per leg). Each linked page is read
  again: a duration the page does not state (a range must be its range; "about 3 hours" is not "3h45–4h45") is
  dropped, its link kept as where to check the times, and listed with what the page says (unconfirmed_durations);
  an unreadable page is not held against it. Leave a leg's duration
  empty ("2h10,,3h") when only some are sourced; a link without a duration is where to check the times (timetable_url).
  Ordered stop-to-stop features for the "legs" layer type, drawn as arcs. --follow <layer>: each leg follows the real
  track of a \`uw lines\` layer (e.g. --follow rail after \`uw lines … --layer rail --kinds rail,hsr\`): train legs use
  conventional rail, hsr legs high-speed lines (either when the other has no path); the card says "km by rail". A leg
  with no connected track near both stops stays an arc ("≈ straight line") and is listed. --modes/--durations: one
  value per leg (stops-1), or a single value used for every leg. Props: id leg-1…, name "A → B", from, to, mode, emoji,
  duration, duration_min, distance_km, track (true when it follows the track), track_km.`,
};

// Shown by the engine in the map credits (GeoJSON top-level "attribution"). FOSSGIS asks for a "fix the map" link.
const ROUTE_ATTRIB = 'Routing: OSRM (FOSSGIS) · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Fix the map</a>';
const ISO_ATTRIB = (mode) => `${mode === 'bike' ? 'Bike areas' : 'Walk areas'}: Valhalla (FOSSGIS) · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Fix the map</a>`;
const MODE_ALIAS = { walk: 'foot', walking: 'foot', pedestrian: 'foot', cycling: 'bike', bicycle: 'bike', drive: 'car', driving: 'car' };

export async function route(argv) {
  const args = parseArgs(argv, { layer: 'string', from: 'string', to: 'string', via: 'multi', mode: 'string', name: 'string', id: 'string',
    append: 'bool', force: 'bool', simplify: 'number' }, { positionals: [1, 1], command: 'route' });
  if (args.help) return console.log(helps.route);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  assertOwned(site, layer, 'route', args.force || args.append);
  if (!args.from || !args.to) throw new UsageError('route needs --from <pt> and --to <pt> (lng,lat or layer:id)');
  const mode = MODE_ALIAS[args.mode] || args.mode || 'foot';
  if (!OSRM_MODES.includes(mode)) throw new UsageError(`--mode "${args.mode}" is not supported; use foot, bike or car`);
  const pts = [resolvePoint(site, args.from, 'from'), ...args.via.map((v) => resolvePoint(site, v, 'via')), resolvePoint(site, args.to, 'to')];
  const straight = pts.slice(1).reduce((d, p, i) => d + haversine(pts[i].coord, p.coord), 0);
  if (straight > (mode === 'foot' ? 60000 : mode === 'bike' ? 200000 : 2000000))
    throw new UsageError(`the stops are ${(straight / 1000).toFixed(0)} km apart, too far for --mode ${mode}. Check the points (lng,lat order) or use legs for long trips.`);
  out.log(`Routing ${pts.map((p) => p.name).join(' → ')} (${mode})…`);
  const { data, label: routedBy } = await routeLookup(pts.map((p) => p.coord), { mode });
  if (data.code !== 'Ok' || !data.routes?.length)
    throw new UserError(`no ${mode} route found (${data.code || 'unknown'}: ${data.message || ''}). Are both points on/near roads or paths?`);
  const r = data.routes[0];
  // Snapping distance: warn when a point is far from the network (likely a bad coordinate).
  (data.waypoints || []).forEach((w, i) => { if (w.distance > 300) out.warn(`${pts[i].name} is ${Math.round(w.distance)} m from the nearest ${mode} path; check that point.`); });
  let coords = r.geometry.coordinates;
  if (args.simplify) coords = simplifyLine(coords, args.simplify);
  const name = args.name || `${pts[0].name} → ${pts[pts.length - 1].name}`;
  const id = args.id || slugify(args.name || '') || `route-${slugify(pts[0].id || 'a')}-${slugify(pts[pts.length - 1].id || 'b')}`.replace(/--+/g, '-');
  const props = {
    id, name, mode, emoji: { foot: '🚶', bike: '🚲', car: '🚗' }[mode],
    duration_min: Math.round(r.duration / 60), distance_km: Math.round(r.distance / 10) / 100,
    from: pts[0].id || pts[0].coord.join(','), to: pts[pts.length - 1].id || pts[pts.length - 1].coord.join(','),
    from_name: pts[0].name, to_name: pts[pts.length - 1].name,
    ...(args.via.length ? { via: pts.slice(1, -1).map((p) => p.id || p.coord.join(',')) } : {}),
    source: `${routedBy} / OpenStreetMap`,
  };
  const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: roundCoords(coords) }, properties: props };
  let features = [feature];
  if (args.append) {
    const prev = loadLayer(site, layer, { required: false });
    if (prev) features = prev.features.filter((f) => f?.properties?.id !== id).concat([feature]);
  }
  const w = writeOwnedLayer(site, layer, { type: 'FeatureCollection', attribution: ROUTE_ATTRIB, features }, { cmd: 'route', force: args.force || args.append, out });
  const hint = layerHint(site, layer, 'route', { style: { color: '#7c3aed', width: 5 }, animate: true });
  const registered = registerLayer(site, hint);
  out.result({ ok: true, layer, file: w.rel, id, mode, duration_min: props.duration_min, distance_km: props.distance_km, count: features.length, registered_layer: registered ? hint : null }, [
    `Wrote route ${layer}:${id} to ${w.rel}: ${props.emoji} ${fmtMinutes(props.duration_min)}, ${props.distance_km} km (${name})`,
    registered,
  ]);
}

export async function isochrone(argv) {
  const args = parseArgs(argv, { layer: 'string', from: 'string', minutes: 'string', mode: 'string', force: 'bool', limit: 'number' },
    { positionals: [1, 1], command: 'isochrone' });
  if (args.help) return console.log(helps.isochrone);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  assertOwned(site, layer, 'isochrone', args.force);
  if (!args.from) throw new UsageError('isochrone needs --from layer:<layerId> (every feature), --from <layer>:<id> or --from lng,lat');
  const mode = MODE_ALIAS[args.mode] || args.mode || 'foot';
  const costing = { foot: 'pedestrian', bike: 'bicycle' }[mode];
  if (!costing) throw new UsageError(`--mode "${args.mode}" is not supported for isochrones; use foot or bike`);
  const minutes = parseList(args.minutes || '10').map(Number);
  if (!minutes.length || minutes.some((m) => !Number.isFinite(m) || m <= 0 || m > 60)) throw new UsageError('--minutes must be 1-60 (comma list allowed, e.g. 5,10,15)');
  if (minutes.length > 4) throw new UsageError('at most 4 --minutes values');

  let sources;
  const m = args.from.match(/^layer:([^:]+)$/);
  if (m) {
    const fc = loadLayer(site, m[1]);
    sources = fc.features.filter((f) => f?.geometry && f.properties?.id != null).map((f) => resolvePoint(site, `${m[1]}:${f.properties.id}`, 'from'));
    if (!sources.length) throw new UserError(`layer "${m[1]}" has no features with ids`);
  } else sources = [resolvePoint(site, args.from, 'from')];
  const max = args.limit ?? 40;
  if (sources.length > max) throw new UsageError(`${sources.length} source features is too many for one run (max ${max}); isochrones are one request each. Use --from <layer>:<id> for specific ones.`);

  const features = [];
  let skipped = null, done = 0;
  for (const [i, s] of sources.entries()) {
    if (i) await sleep(1000);
    const body = { locations: [{ lat: s.coord[1], lon: s.coord[0] }], costing, contours: minutes.map((t) => ({ time: t })), polygons: true, denoise: 0.5, generalize: 15 };
    out.log(`  ${i + 1}/${sources.length} ${s.name}…`);
    let data;
    try { ({ data } = await isochroneLookup(body)); } catch (e) {
      if (e.status === 400) { out.warn(`${s.name}: Valhalla could not compute an isochrone here (${e.message.slice(0, 160)}); skipped`); continue; }
      // out of time: write the walk areas finished so far (each is complete), then report the skip
      if (isSkip(e) && features.length) { skipped = e; skipped.at = i; break; }
      throw e;
    }
    done++;
    for (const f of data.features || []) {
      if (!f.geometry || !/Polygon/.test(f.geometry.type)) continue;
      const mins = Math.round(f.properties?.contour ?? minutes[0]);
      const forId = s.id || `${s.coord[0]},${s.coord[1]}`;
      features.push({ type: 'Feature', geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
        properties: { id: `${s.id ? s.id : 'pt'}-${mins}min`, name: `${mins} min ${mode === 'foot' ? 'walk' : 'ride'} from ${s.name}`, for: forId,
          ...(s.layer ? { for_layer: s.layer } : {}), minutes: mins, mode, source: 'Valhalla / OpenStreetMap (valhalla1.openstreetmap.de)' } });
    }
  }
  // Larger contours first so smaller ones draw on top.
  features.sort((a, b) => b.properties.minutes - a.properties.minutes);
  // ids must be unique even for repeated coordinate sources
  const seen = new Map();
  for (const f of features) { const n = seen.get(f.properties.id) || 0; seen.set(f.properties.id, n + 1); if (n) f.properties.id += `-${n + 1}`; }
  if (!features.length) throw new UserError('no isochrones were produced; nothing written');
  const w = writeOwnedLayer(site, layer, { type: 'FeatureCollection', attribution: ISO_ATTRIB(mode), features }, { cmd: 'isochrone', args: { from: args.from, minutes: minutes.join(','), mode }, force: args.force, out });
  const linked = m ? m[1] : sources[0].layer;
  const hint = layerHint(site, layer, 'areas', { style: { color: '#3b82f6', opacity: 0.14, outline: true }, ...(linked ? { linkedTo: linked } : {}) });
  const registered = registerLayer(site, hint);
  if (skipped) {
    if (registered) out.log(registered);
    skipped.kept = `${done} of ${sources.length} walk areas in ${w.rel} (not reached: ${sources.slice(skipped.at).map((x) => x.id || x.name).join(', ')})`;
    throw skipped;
  }
  out.result({ ok: true, layer, file: w.rel, count: features.length, minutes, mode, linkedTo: linked || null, registered_layer: registered ? hint : null }, [
    `Wrote ${features.length} isochrone polygon(s) (${minutes.join('/')} min ${mode}) to ${w.rel}${linked ? `; each has "for" = a ${linked} id` : ''}`,
    registered,
  ]);
}

const LEG_EMOJI = { train: '🚆', hsr: '🚄', bus: '🚌', car: '🚗', taxi: '🚕', flight: '✈️', plane: '✈️', ferry: '⛴️', boat: '⛴️', walk: '🚶', bike: '🚲', metro: '🚇', mrt: '🚇', subway: '🚇', scooter: '🛵' };
const LEG_NORM = { plane: 'flight', fly: 'flight', boat: 'ferry', mrt: 'metro', subway: 'metro', foot: 'walk', walking: 'walk', drive: 'car', cycling: 'bike', bicycle: 'bike', shinkansen: 'hsr', 'high-speed': 'hsr' };

export async function legs(argv) {
  const args = parseArgs(argv, { layer: 'string', stops: 'string', modes: 'string', durations: 'string', source: 'string', 'source-url': 'string', 'no-source-check': 'bool', follow: 'string', force: 'bool' }, { positionals: [1, 1], command: 'legs' });
  if (args.help) return console.log(helps.legs);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  assertOwned(site, layer, 'legs', args.force);
  if (!args.stops) throw new UsageError('legs needs --stops "<layer>:<id>,<layer>:<id>,…" (at least two)');
  const refs = args.stops.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (refs.some((r) => !r.includes(':'))) throw new UsageError('--stops takes layer refs only (e.g. cities:taipei,cities:hualien). Add raw coordinates as points first (add-point).');
  const stops = refs.map((r) => resolvePoint(site, r, 'stops'));
  if (stops.length < 2) throw new UsageError('--stops needs at least two stops');
  const n = stops.length - 1;
  const perLeg = (s, flag) => {
    if (!s) return Array(n).fill(null);
    const v = flag === 'modes' ? parseList(s) : String(s).split(',').map((x) => x.trim() || null); // empty = none for that leg
    if (v.length === 1) return Array(n).fill(v[0]);
    if (v.length !== n) throw new UsageError(`--${flag} has ${v.length} values but there are ${n} legs (${stops.length} stops). Give ${n} values or one for all.`);
    return v;
  };
  const modes = perLeg(args.modes, 'modes').map((m) => (m ? LEG_NORM[m.toLowerCase()] || m.toLowerCase() : null));
  for (const m of modes) if (m && !LEG_EMOJI[m]) throw new UsageError(`unknown mode "${m}". Use: ${Object.keys(LEG_EMOJI).join(', ')}`);
  const durs = perLeg(args.durations, 'durations');
  const urls = perLeg(args['source-url'], 'source-url'); // one link for all legs, or one per leg (empty = none)
  for (const u of urls) if (u && !/^https:\/\/[^\s,]+$/.test(u)) throw new UsageError(`--source-url "${u}" must be an https:// link (the timetable page the durations came from)`);
  let graphs = null, followMissing = false, followPartial = null;
  // the track layer can be missing when `uw lines` was skipped (Overpass busy): the legs are still written, as arcs
  if (args.follow && !loadLayer(site, checkLayerId(args.follow), { required: false })) {
    followMissing = true;
    out.warn(`--follow ${args.follow}: no such lines layer yet (was \`uw lines\` skipped?); writing arcs. Later: uw lines ${args._[0]} --layer ${args.follow} --kinds rail,hsr --simplify 80, then this command again.`);
  } else if (args.follow) {
    const lf = loadLayer(site, checkLayerId(args.follow));
    followPartial = lf.uw?.partial || null; // some map tiles of the track did not load (uw lines PARTIAL)
    const { buildGraph } = await import('./rail-graph.mjs');
    const isHsr = (f) => f?.properties?.kind === 'hsr';
    graphs = { all: buildGraph(lf), hsr: buildGraph(lf, { filter: isHsr }), rail: buildGraph(lf, { filter: (f) => !isHsr(f) }) };
    if (!graphs.all.coords.length) throw new UserError(`--follow ${args.follow}: that layer has no lines (run: uw lines ${args._[0]} --layer ${args.follow} --kinds rail,hsr)`);
  }
  if (args.durations && !args.source) out.warn('durations should come from the user or a published timetable; say which with --source "THSR timetable" (shown on the card).');
  const features = [], noTrack = [];
  for (let i = 0; i < n; i++) {
    const a = stops[i], b = stops[i + 1];
    const props = { id: `leg-${i + 1}`, order: i + 1, name: `${a.name} → ${b.name}`, from: a.id, to: b.id, from_name: a.name, to_name: b.name };
    if (a.feature?.properties?.name_en || b.feature?.properties?.name_en)
      props.name_en = `${a.feature?.properties?.name_en || a.name} → ${b.feature?.properties?.name_en || b.name}`;
    if (modes[i]) { props.mode = modes[i]; props.emoji = LEG_EMOJI[modes[i]]; }
    if (durs[i]) {
      // a source that gives a range ("2 to 3 h") keeps it: "2h–3h", never a midpoint
      const parts = String(durs[i]).split(/\s*[–—-]\s*/);
      let mins = null, maxMins = null;
      if (parts.length === 2) { mins = parseDuration(parts[0]); maxMins = parseDuration(parts[1]); if (mins == null || maxMins == null || maxMins < mins) mins = null; }
      else mins = parseDuration(durs[i]);
      if (mins == null) throw new UsageError(`--durations value "${durs[i]}" not understood; use forms like 1h45, 45m, 2h, 90, or a range 2h–3h`);
      props.duration_min = mins; props.duration = fmtMinutes(mins);
      if (maxMins != null && maxMins !== mins) { props.duration_max_min = maxMins; props.duration = `${fmtMinutes(mins)}–${fmtMinutes(maxMins)}`; }
      if (args.source) props.duration_source = args.source;
    }
    // a sourced duration links to its timetable; without a duration the link is where to check the times
    if (urls[i]) props[durs[i] ? 'duration_source_url' : 'timetable_url'] = urls[i];
    props.distance_km = Math.round(haversine(a.coord, b.coord) / 100) / 10;
    let geom = [a.coord.map(round6), b.coord.map(round6)];
    if (graphs && !['flight', 'walk', 'car', 'taxi', 'bus'].includes(modes[i])) {
      const { trackPath } = await import('./rail-graph.mjs');
      const order = modes[i] === 'hsr' ? ['hsr', 'all'] : modes[i] === 'ferry' ? ['all'] : ['rail', 'all'];
      let tp = null;
      for (const k of order) { if (graphs[k].coords.length && (tp = trackPath(graphs[k], a.coord, b.coord))) break; }
      if (tp) { geom = tp.coords; props.track = true; props.track_km = tp.km; props.distance_km = tp.km; props.track_source = `OpenStreetMap (${args.follow} layer)`; }
      else {
        noTrack.push(props.name);
        props.track_note = followPartial ? 'Drawn straight: part of the rail track did not load' : 'Drawn straight: no connected track found';
      }
    } else if (followMissing && !['flight', 'walk', 'car', 'taxi', 'bus'].includes(modes[i])) {
      props.track_note = 'Drawn straight: the rail track did not load';
    }
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: geom }, properties: props });
  }
  const unconfirmed = args['no-source-check'] ? [] : await confirmLegDurations(features);
  const w = writeOwnedLayer(site, layer, { type: 'FeatureCollection', features }, { cmd: 'legs', args: { stops: args.stops }, force: args.force, out });
  const hint = layerHint(site, layer, 'legs', { style: { color: '#0ea5e9' } });
  const registered = registerLayer(site, hint);
  out.result({ ok: true, layer, file: w.rel, count: features.length, legs: features.map((f) => f.properties), no_track: noTrack, ...(followMissing ? { follow_missing: args.follow } : {}),
    ...(unconfirmed.length ? { unconfirmed_durations: unconfirmed } : {}), registered_layer: registered ? hint : null }, [
    `Wrote ${n} leg(s) to ${w.rel}: ` + features.map((f) => `${f.properties.emoji || ''}${f.properties.name}${f.properties.duration ? ` (${f.properties.duration})` : ''}${f.properties.track ? ` [${f.properties.track_km} km by rail]` : ''}`).join(' · '),
    unconfirmed.length ? `Dropped ${unconfirmed.length} duration(s) their page does not state: ${unconfirmed.map((u) => `${u.leg} gave ${u.gave}, ${u.page_says ? `the page says ${u.page_says}` : 'the page states no travel time'}`).join(' · ')}. Copy the page's own number (a range stays a range) and run legs again, or leave it empty; the card links the page to check the times.` : null,
    noTrack.length ? `No connected track for: ${noTrack.join(' · ')} (drawn as arcs, each card says "Drawn straight"). ${followPartial ? `Part of the track did not load: ${followPartial.refetch || 'run uw lines again'}, then this command again.` : 'Fetch more track (uw lines … --kinds rail,hsr with a wider --bbox) or leave them.'}` : null,
    registered,
  ]);
}

/** Read each page a sourced duration cites (uw cite's rules) and drop a duration its page does not state: the leg
 *  keeps the link as where to check the times. Unreadable pages are left alone. Mutates the features; returns what
 *  was dropped. Exported for the tests (`fetchPage` stands in for the network). */
export async function confirmLegDurations(features, { fetchPage = politeFetch, maxPages = 10 } = {}) {
  const sourced = features.filter((f) => f.properties.duration_min != null && f.properties.duration_source_url);
  const urls = [...new Set(sourced.map((f) => f.properties.duration_source_url))].slice(0, maxPages);
  const pages = new Map();
  for (const url of urls) {
    try {
      const r = await fetchPage(url, { timeoutMs: 15000 });
      if (!r.refused && r.status < 400) pages.set(url, /json/i.test(r.type || '') ? r.text : pageText(r.text).lines.join('\n'));
    } catch (e) {
      if (isSkip(e)) break;
    }
  }
  const dropped = [];
  for (const f of sourced) {
    const p = f.properties, text = pages.get(p.duration_source_url);
    if (text == null || pageStatesDuration(text, p.duration_min, p.duration_max_min ?? p.duration_min)) continue;
    dropped.push({ leg: p.name, gave: p.duration, page_says: describeDurations(pageDurations(text), fmtMinutes) || null, url: p.duration_source_url });
    p.timetable_url = p.duration_source_url;
    p.duration_note = 'The cited page does not state this travel time';
    for (const k of ['duration', 'duration_min', 'duration_max_min', 'duration_source', 'duration_source_url']) delete p[k];
  }
  return dropped;
}
