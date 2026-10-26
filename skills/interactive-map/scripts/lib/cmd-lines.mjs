// `lines`: transit / rail / ferry / cycleway lines from OSM. Route relations preferred (one feature per line, OSM colour),
// ways as fallback when an area has no route relations for a kind.
import { parseArgs, makeOut, parseBBox, parseList, bboxAreaKm2, mergeLines, simplifyLine, roundCoords, lineLengthM, fmtBytes, UsageError } from './util.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { overpass, isSkip, timeLeft, withCap, sharedCacheDir, deadlineSkip, fetchJSON, fetchBuffer } from './net.mjs';
import { decodeTile, tileRange } from './mvt.mjs';
import { sleep } from './util.mjs';
import { openSite, checkLayerId, writeOwnedLayer, assertOwned, layerHint, registerLayer, viewBounds, layerBBox, setLayerPartial } from './site.mjs';

export const TILE_KM2 = 25000, TILE_DEG = 1.5, TILE_CACHE_DAYS = 30, MAX_TILES = 80;

export const help = `lines <dir> --layer <id> --kinds subway,rail,hsr,tram,light_rail,heritage,ferry,cycleway [--bbox w,s,e,n | --around <layerId> [--radius 3000]]
       [--simplify m] [--exclude-name regex] [--force] [--force-large] [--json]
  Overpass → data/<layer>.geojson (Multi)LineStrings with id, name, name_en, ref, colour (OSM colour tag), kind, network, operator.
  Transit comes from route relations (both directions merged into one feature per line); plain railway/ferry/cycleway
  ways are used when a kind has no relations in the area. Without --bbox the config's view.bounds grown by 30% is used
  (lines run past the stops they connect). Lines that share a colour but have different refs (trams 1, 5, 7…) stay separate.
  heritage = tourist / heritage railways (usage=tourism, railway=preserved), e.g. the Alishan Forest Railway; "rail" leaves them out.
  Non-passenger track is dropped: sidings/yards (service=*), industrial/military/freight use, and names like sugar railway,
  mine, kindergarten, freight (--exclude-name adds your own regex).
  --simplify metres (default 8; use 80+ for country scale). Areas > 60 km² need an explicit --simplify (or --force-large).
  Areas over ${TILE_KM2.toLocaleString('en')} km² (a country, a long rail trip) are fetched as map tiles of ${TILE_DEG}°, one small
  query each, kept for ${TILE_CACHE_DAYS} days in the cache every site shares (UW_CACHE, default ~/.cache/uw): a tile Overpass
  could not answer is asked again after a pause, and what still failed is listed. Then the layer is written with the
  tiles that loaded, marked PARTIAL ("rail track for 3 of 12 map tiles did not load"); the same command later fetches
  only the missing tiles. Rail (rail, hsr) that Overpass could not give at all, or for the missing tiles, comes from
  the basemap's own vector tiles instead (OpenFreeMap, OpenMapTiles schema: the track the map already draws), marked
  PARTIAL: no line names, high-speed lines not marked (a leg's HSR question is then "unknown"). Legs over track that
  is still missing stay arcs and say so. UW_BASEMAP_TILES points at another TileJSON.
  Style tip: { "type": "lines", "style": { "color": "{colour}", "width": 4 } }`;

const HSR_NAME = /high[ -]?speed|高鐵|高铁|高速鐵路|新幹線|shinkansen|\bHSR\b|\bTHSR\b|\bKTX\b|\bTGV\b|\bICE\b|\bAVE\b|Frecciarossa|\bCRH\b/i;
const KIND_EMOJI = { subway: '🚇', light_rail: '🚈', tram: '🚊', rail: '🚆', hsr: '🚄', heritage: '🚂', ferry: '⛴️', cycleway: '🚲' };
// names of track nobody rides on a trip (sugar-cane lines, mine tunnels, kindergarten trains, sidings, freight spurs)
const JUNK_NAME = /糖|sugar|幼兒園|幼稚園|kindergarten|坑道|礦|mine\b|待避|siding|貨運|freight|industrial|工業|港區|臨港|port railway/i;
const KIND_LIST = Object.keys(KIND_EMOJI);
const ALIAS = { metro: 'subway', mrt: 'subway', train: 'rail', railway: 'rail', railways: 'rail', trains: 'rail', 'high_speed': 'hsr',
  highspeed: 'hsr', lrt: 'light_rail', monorail: 'light_rail', trams: 'tram', ferries: 'ferry', boat: 'ferry', bike: 'cycleway',
  cycleways: 'cycleway', bikeway: 'cycleway', 'light-rail': 'light_rail', tourist: 'heritage', tourist_rail: 'heritage', preserved: 'heritage', forest: 'heritage' };

export async function run(argv) {
  const args = parseArgs(argv, { layer: 'string', kinds: 'string', bbox: 'string', around: 'string', radius: 'number', simplify: 'number', force: 'bool', 'force-large': 'bool', 'exclude-name': 'string' },
    { positionals: [1, 1], command: 'lines' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  assertOwned(site, layer, 'lines', args.force);
  const kinds = [];
  for (const k0 of parseList(args.kinds || 'subway,light_rail')) {
    const k = ALIAS[k0.toLowerCase()] || k0.toLowerCase();
    if (!KIND_LIST.includes(k)) throw new UsageError(`unknown line kind "${k0}". Known: ${KIND_LIST.join(', ')}`);
    if (!kinds.includes(k)) kinds.push(k);
  }
  let bbox = args.bbox ? parseBBox(args.bbox) : args.around ? layerBBox(site, args.around, args.radius ?? 3000) : viewBounds(site);
  if (!bbox) throw new UsageError('give --bbox w,s,e,n or --around <layer> (map.config.json has no view.bounds to fall back on)');
  if (args.around) out.log(`Around layer "${args.around}" + ${args.radius ?? 3000} m: ${bbox.join(',')}`);
  else if (!args.bbox) {
    // a line loops past the stops that framed the view (Taiwan's South-Link runs well south of Taitung): grow it 30%
    const gx = (bbox[2] - bbox[0]) * 0.3, gy = (bbox[3] - bbox[1]) * 0.3;
    bbox = [bbox[0] - gx, bbox[1] - gy, bbox[2] + gx, bbox[3] + gy].map((v) => Math.round(v * 1e6) / 1e6);
    out.log(`Using view.bounds from map.config.json grown by 30%: ${bbox.join(',')}`);
  }
  let excl = null;
  if (args['exclude-name']) { try { excl = new RegExp(args['exclude-name'], 'i'); } catch (e) { throw new UsageError(`--exclude-name is not a valid regex: ${e.message}`); } }
  const junk = (t) => (/^(rail|narrow_gauge|light_rail|subway|tram)$/.test(t.railway || '') && (t.service || /^(industrial|military|test|freight)$/.test(t.usage || ''))) ||
    JUNK_NAME.test(`${t.name || ''} ${t['name:en'] || ''} ${t.operator || ''}`) || (excl && excl.test(`${t.name || ''} ${t['name:en'] || ''} ${t.ref || ''}`));
  const km2 = bboxAreaKm2(bbox);
  const simplify = args.simplify ?? 8;
  if (simplify < 0) throw new UsageError('--simplify must be >= 0 metres');
  if (km2 > 60 && args.simplify === undefined && !args['force-large'])
    throw new UsageError(`area is ${km2.toFixed(0)} km² (> 60 km²). For large areas pass --simplify (e.g. --simplify 80 for a whole country) or --force-large.`);
  if (km2 > 2000 && simplify < 50) out.warn(`area is ${km2.toFixed(0)} km² with --simplify ${simplify}; consider --simplify 80+ to keep the file small.`);
  // above TILE_KM2 the area is fetched as tiles (fetchTiles), capped at MAX_TILES

  const rel = new Set(), ways = [];
  const want = (k) => kinds.includes(k);
  if (want('subway')) { rel.add('subway'); ways.push('way["railway"="subway"]'); }
  if (want('light_rail')) { rel.add('light_rail'); rel.add('monorail'); ways.push('way["railway"~"^(light_rail|monorail)$"]'); }
  if (want('tram')) { rel.add('tram'); ways.push('way["railway"="tram"]'); }
  if (want('rail') || want('hsr')) { rel.add('train'); }
  if (want('rail')) ways.push('way["railway"~"^(rail|narrow_gauge)$"]["service"!~"."]["usage"!~"^(industrial|military|test|tourism)$"]');
  if (want('heritage')) { rel.add('train'); ways.push('way["railway"~"^(rail|narrow_gauge|preserved)$"]["usage"="tourism"]', 'way["railway"="preserved"]'); }
  if (!want('rail') && want('hsr')) { ways.push('way["railway"="rail"]["highspeed"="yes"]'); ways.push('way["railway"="rail"]["usage"="main"]["name"~"high.?speed|高鐵|高铁|新幹線|HSR",i]'); }
  if (want('ferry')) { rel.add('ferry'); ways.push('way["route"="ferry"]'); }
  if (want('cycleway')) { ways.push('way["highway"="cycleway"]'); ways.push('way["highway"="path"]["bicycle"="designated"]'); }
  // Relations are printed without geometry (members only); their ways are printed once with clipped geometry.
  // Per-train-number relations (common in Taiwan/Japan: "自強 103 七堵->潮州") are skipped; the track ways cover them.
  const relSel = [];
  const tr = [...rel].filter((r) => r !== 'train');
  if (tr.length) relSel.push(`relation["type"="route"]["route"~"^(${tr.join('|')})$"];`);
  if (rel.has('train')) relSel.push('relation["type"="route"]["route"="train"]["ref"!~"^[0-9]{2,}$"]["name"!~"[0-9]{3,}"];');
  // one area: ways clipped to it; a tile: whole ways (a way that crosses a tile edge is kept once, by id, uncut)
  const query = (bb, { clip = true, timeout = 120 } = {}) => {
    const B = `${bb[1]},${bb[0]},${bb[3]},${bb[2]}`;
    const g = clip ? `geom(${B})` : 'geom';
    return `[out:json][timeout:${timeout}][bbox:${B}];
(
${relSel.map((r) => '  ' + r).join('\n')}
)->.rels;
.rels out body;
way(r.rels)(${B})->.rw;
.rw out ${g};
(
${ways.map((w) => `  ${w};`).join('\n')}
)->.fw;
(.fw; - .rw;)->.only;
.only out ${g};`;
  };
  let data, tiles = null, basemap = null;
  // rail is also drawn by the basemap: when Overpass cannot answer, its vector tiles give the track (no names, no HSR)
  const railOnly = kinds.every((k) => k === 'rail' || k === 'hsr');
  try {
    if (km2 > TILE_KM2) {
      tiles = await fetchTiles(bbox, query, out, kinds, { allowNone: railOnly });
      data = tiles.data;
    } else {
      out.log(`Querying Overpass for ${kinds.join(', ')} lines (${km2 < 10 ? km2.toFixed(1) : km2.toFixed(0)} km²)…`);
      data = await overpass(query(bbox), { timeoutS: 120 });
    }
  } catch (e) {
    if (!railOnly || !isSkip(e)) throw e;
    out.warn(`Overpass ${e.why || 'busy'}; taking the rail track from the basemap tiles instead`);
    tiles = { data: { elements: [] }, total: 1, missing: [bbox], cached: 0, overpassFailed: true };
    data = tiles.data;
  }
  if (railOnly && tiles?.missing.length) {
    try { basemap = await basemapRail(tiles.missing, simplify, out); } catch (e) {
      if (tiles.overpassFailed) throw isSkip(e) ? e : deadlineSkip('Overpass and the basemap tiles');
      out.warn(`basemap tiles: ${e.message}`);
    }
    if (tiles.overpassFailed && !basemap?.features.length) throw deadlineSkip('Overpass');
  }

  const relFeats = [], wayEls = [], wayGeom = new Map();
  for (const el of data.elements || []) {
    if (el.type === 'relation') relFeats.push(el);
    else if (el.type === 'way' && el.geometry) {
      const coords = el.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
      if (coords.length >= 2) { wayGeom.set(el.id, coords); wayEls.push(el); }
    }
  }

  // --- relations: group directions/variants of the same line, merge member ways (deduped by way id)
  const groups = new Map();
  for (const r of relFeats) {
    const t = r.tags || {};
    const kind = relKind(t);
    if (!kind || !keepKind(kind, kinds) || junk(t)) continue;
    // One feature per line: both directions / variants share network + ref. Only without a ref does colour group them
    // (Amsterdam's trams 1, 5, 7, 12, 14 and 19 are all #ff7f00: grouping by colour made them one "Tram 7").
    const colour = normColour(t.colour || '');
    const lineKey = t.ref ? [kind, t.network || '', t.ref].join('|') : [kind, colour || stripDir(t.name || '')].join('|');
    let g = groups.get(lineKey);
    if (!g) groups.set(lineKey, (g = { kind, rels: [], ways: new Map() }));
    g.rels.push(r);
    for (const m of r.members || []) {
      if (m.type !== 'way' || /platform|stop|station/.test(m.role || '')) continue;
      const coords = wayGeom.get(m.ref);
      if (coords && !g.ways.has(m.ref)) g.ways.set(m.ref, coords);
    }
  }
  const relWayIds = new Set();
  for (const g of groups.values()) for (const id of g.ways.keys()) relWayIds.add(id);
  const features = [];
  const kindsFromRel = new Set();
  for (const g of groups.values()) {
    if (!g.ways.size) continue;
    g.rels.sort((a, b) => a.id - b.id);
    const best = g.rels.slice().sort((a, b) => relScore(b.tags || {}) - relScore(a.tags || {}))[0];
    const t = { ...(best.tags || {}) };
    for (const r of g.rels) { // fill gaps from sibling relations
      const o = r.tags || {};
      if (!t.colour && o.colour) t.colour = o.colour;
      if (!t.ref && o.ref) t.ref = o.ref;
      if (!t.network && o.network) t.network = o.network;
      if (!englishOk(t['name:en']) && englishOk(o['name:en'])) t['name:en'] = o['name:en'];
    }
    if (!englishOk(t['name:en']) && t.description && t.description.length < 40 && /^[\x20-\x7e\u2013\u2014]+$/.test(t.description)) t['name:en'] = t.description;
    if (t['name:en'] && !englishOk(t['name:en'])) t['name:en'] = stripDir(t['name:en']);
    const geom = buildGeom([...g.ways.values()], simplify);
    if (!geom) continue;
    kindsFromRel.add(g.kind);
    features.push(lineFeature(`osm-r${g.rels[0].id}`, g.kind, t, geom, { relations: g.rels.length }));
  }

  // --- ways not covered by any route relation. Kept when relations are missing or clearly incomplete for that kind
  // (e.g. Taiwan's TRA network has no line relations), dropped when they are just depot/siding leftovers.
  const lenOf = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot((pts[i][0] - pts[i - 1][0]) * Math.cos((pts[i][1] * Math.PI) / 180), pts[i][1] - pts[i - 1][1]); return d; };
  const relLen = {}, leftLen = {};
  for (const g of groups.values()) for (const c of g.ways.values()) relLen[g.kind] = (relLen[g.kind] || 0) + lenOf(c);
  const wayGroups = new Map();
  for (const w of wayEls) {
    const t = w.tags || {};
    const kind = wayKind(t);
    if (!kind || !keepKind(kind, kinds) || relWayIds.has(w.id) || junk(t)) continue;
    // Bridges/tunnels/platform pieces are often named after the structure ("4號橋"), so prefer the line ref.
    const structural = /橋|隧道|tunnel|bridge|viaduct|月台|platform|高架/i.test(t.name || '') || t.bridge === 'yes' && !t.ref;
    const name = structural ? '' : t.name || '';
    const k = [kind, t.ref || name || '', t.ref || name ? '' : (t.colour || '')].join('|');
    let g = wayGroups.get(k);
    if (!g) wayGroups.set(k, (g = { kind, ids: [], parts: [], tags: structural ? { ...t, name: t.ref || undefined } : t }));
    else if (!g.tags.name && name) g.tags = t;
    if (name) (g.names ||= new Set()).add(name);
    g.ids.push(w.id);
    const pts = w.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
    g.parts.push(pts);
    leftLen[kind] = (leftLen[kind] || 0) + lenOf(pts);
  }
  const keepLeftovers = (kind) => kind === 'cycleway' || !relLen[kind] || (leftLen[kind] || 0) > 0.25 * relLen[kind];
  let droppedLeftovers = 0;
  for (const g of wayGroups.values()) {
    if (!keepLeftovers(g.kind)) { droppedLeftovers += g.ids.length; continue; }
    const geom = buildGeom(g.parts, simplify);
    if (!geom) continue;
    const id = `osm-w${Math.min(...g.ids)}`;
    // A ref-grouped line whose pieces carry different names ("縱貫線東正線", "縱貫線西正線") is named by its ref.
    const tags = g.tags.ref && g.names?.size > 1 ? { ...g.tags, name: g.tags.ref, 'name:en': undefined } : g.tags;
    features.push(lineFeature(id, g.kind, tags, geom, { ways: g.ids.length }));
  }
  if (basemap?.features.length) features.push(...basemap.features);
  features.sort((a, b) => KIND_LIST.indexOf(a.properties.kind) - KIND_LIST.indexOf(b.properties.kind) ||
    String(a.properties.ref || a.properties.name).localeCompare(String(b.properties.ref || b.properties.name), 'en', { numeric: true }));
  if (!features.length) out.warn(`no ${kinds.join('/')} lines found in this area. Check the bbox (order w,s,e,n) and kinds.`);

  // tiles Overpass never answered: the layer is what loaded, marked partial; the same command fetches the rest
  const refetch = `uw ${['lines', ...argv.filter((a) => a !== '--json')].map((a) => (/^[\w:.,/@%+=~-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}${argv.includes('--timeout') ? '' : ' --timeout 180'}`;
  const partial = !tiles?.missing.length ? null : basemap?.features.length
    ? { reason: tiles.overpassFailed ? 'Overpass was busy: rail track from the basemap tiles (no line names; high-speed lines not marked)'
      : `rail track for ${tiles.missing.length} of ${tiles.total} map tiles from the basemap tiles (Overpass busy; no line names, high-speed lines not marked)`,
    refetch, fallback: 'basemap', missing_tiles: tiles.missing.map((t) => t.join(',')) }
    : { reason: `${kinds.includes('rail') || kinds.includes('hsr') ? 'rail track' : 'lines'} for ${tiles.missing.length} of ${tiles.total} map tiles did not load (Overpass busy); legs there stay straight arcs`, refetch, missing_tiles: tiles.missing.map((t) => t.join(',')) };
  const w = writeOwnedLayer(site, layer, { type: 'FeatureCollection', features, ...(basemap?.features.length ? { attribution: BASEMAP_ATTRIB } : {}) }, {
    cmd: 'lines', args: { kinds: kinds.join(','), bbox: bbox.join(','), simplify, ...(tiles ? { tiles: tiles.total } : {}) }, force: args.force, out, partial });
  const byKind = {};
  for (const f of features) byKind[f.properties.kind] = (byKind[f.properties.kind] || 0) + 1;
  const names = features.slice(0, 8).map((f) => `${f.properties.name_en || f.properties.name}${f.properties.colour ? ` ${f.properties.colour}` : ''}`);
  const hint = layerHint(site, layer, 'lines', { style: { color: '{colour}', width: 4 } });
  const registered = registerLayer(site, hint);
  const partialNote = setLayerPartial(site, layer, partial ? partial.reason : null);
  out.result({ ok: true, layer, file: w.rel, bytes: w.bytes, count: features.length, by_kind: byKind, from_relations: [...kindsFromRel],
    lines: names, cached: !!data._cached, registered_layer: registered ? hint : null,
    ...(tiles ? { tiles: { total: tiles.total, loaded: tiles.total - tiles.missing.length, from_cache: tiles.cached, missing: tiles.missing.map((t) => t.join(',')) } } : {}), partial }, [
    `Wrote ${features.length} lines to ${w.rel} (${fmtBytes(w.bytes)}, simplify ${simplify} m): ` +
      Object.entries(byKind).map(([k, n]) => `${KIND_EMOJI[k]}${k} ${n}`).join(', '),
    tiles && !tiles.overpassFailed ? `Map tiles: ${tiles.total - tiles.missing.length} of ${tiles.total} loaded (${tiles.cached} from the shared cache).` : null,
    basemap?.features.length ? `Basemap tiles (z${basemap.z}, ${basemap.tiles} tile(s)${basemap.cached ? `, ${basemap.cached} cached` : ''}): rail track where Overpass gave none.` : null,
    partial ? `PARTIAL: ${partial.reason}. Run it again (the loaded tiles are cached, only the missing ones are asked): ${partial.refetch}` : null,
    partialNote && !partial ? partialNote : null,
    names.length ? `e.g. ${names.join(' · ')}` : null,
    registered,
  ]);
}

/** The ${TILE_DEG}° grid cells (aligned to the globe, so every site asks for the same tiles) that cover a bbox. */
export function tilesFor(bbox, deg = TILE_DEG) {
  const r = (v) => Math.round(v * 1e6) / 1e6;
  const out = [];
  for (let s = Math.floor(bbox[1] / deg) * deg; s < bbox[3]; s += deg) {
    for (let w = Math.floor(bbox[0] / deg) * deg; w < bbox[2]; w += deg) out.push([r(w), r(s), r(w + deg), r(s + deg)]);
  }
  return out;
}

/** Fetch a large area as tiles: one small Overpass query each (busy servers refuse big ones first), each answer kept
 *  in the shared cache, a second round after a pause for the tiles that failed. Returns the merged elements (ways and
 *  relations once each, by id), the tiles still missing and how many came from the cache. Throws the skip (exit 4)
 *  only when no tile loaded at all. */
async function fetchTiles(bbox, query, out, kinds, { allowNone = false } = {}) {
  const tiles = tilesFor(bbox);
  if (tiles.length > MAX_TILES) throw new UsageError(`area needs ${tiles.length} map tiles (> ${MAX_TILES}); split it into regions (--bbox per region, --append is not needed: one layer per region)`);
  const shared = { dir: sharedCacheDir('overpass-tiles'), maxAgeMs: TILE_CACHE_DAYS * 864e5 };
  out.log(`Querying Overpass for ${kinds.join(', ')} lines as ${tiles.length} map tiles of ${TILE_DEG}° (shared cache, ${TILE_CACHE_DAYS} days)…`);
  const els = new Map();
  let missing = tiles, cached = 0, lastSkip = null;
  for (let round = 0; round < 2 && missing.length; round++) {
    if (round) {
      // a pause, then the failed tiles once more, while the command's time allows
      const pause = Math.min(Number(process.env.UW_RETRY_PAUSE_MS ?? 10000), timeLeft() / 6);
      if (timeLeft() - pause < 15000) break;
      out.log(`  ${missing.length} tile(s) did not load; asking again in ${Math.round(pause / 1000)} s…`);
      await sleep(pause);
    }
    const failed = [];
    let loaded = 0;
    for (const [i, t] of missing.entries()) {
      if (timeLeft() < 4000) { failed.push(...missing.slice(i)); break; }
      // three busy answers in a row and none loaded this round: Overpass is down; stop asking it for now (the rest
      // stay missing: the basemap fills rail, and the same command later asks again)
      if (!loaded && failed.length >= 3 && missing.length > 3) { failed.push(...missing.slice(i)); out.warn('Overpass answered busy for 3 tiles in a row; not asking it for the rest now'); break; }
      try {
        // one tile never takes the whole limit: a hung server must leave time for the other tiles
        const cap = Math.max(12000, Math.min(45000, timeLeft() / 2));
        const d = await withCap(cap, () => overpass(query(t, { clip: false, timeout: 60 }), { timeoutS: 60, quick: true, shared }));
        if (d._cached) cached++;
        loaded++;
        for (const el of d.elements || []) { const k = `${el.type}/${el.id}`; if (!els.has(k)) els.set(k, el); }
      } catch (e) {
        if (!isSkip(e)) throw e;
        lastSkip = e; failed.push(t);
      }
    }
    missing = failed;
  }
  if (missing.length === tiles.length && !allowNone) throw lastSkip || deadlineSkip('Overpass');
  if (missing.length === tiles.length) return { data: { elements: [] }, total: tiles.length, missing, cached, overpassFailed: true };
  if (missing.length) out.warn(`${missing.length} of ${tiles.length} map tiles did not load (${lastSkip?.why || 'Overpass busy'}); writing what loaded`);
  return { data: { elements: [...els.values()], _cached: cached === tiles.length }, total: tiles.length, missing, cached };
}

const BASEMAP_TILEJSON = process.env.UW_BASEMAP_TILES || 'https://tiles.openfreemap.org/planet';
const BASEMAP_ATTRIB = 'Rail track: <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const MAX_BASEMAP_TILES = 40;

/** Rail track from the basemap's vector tiles (OpenMapTiles "transportation", class rail, no service tracks) for the
 *  given bboxes: one merged, simplified feature per area. The zoom is the most detailed one that keeps the tile count
 *  ≤ MAX_BASEMAP_TILES (z8 for a country: main lines; z10 for a region). Tiles are kept in the shared cache. */
async function basemapRail(areas, simplify, out) {
  const tj = await fetchJSON(BASEMAP_TILEJSON, { label: 'basemap tiles', retries: 1, timeoutMs: 15000, cacheMaxAgeMs: 864e5 });
  const tpl = Array.isArray(tj?.tiles) ? tj.tiles[0] : null;
  if (typeof tpl !== 'string' || !/^https?:\/\//.test(tpl)) throw new Error('the basemap TileJSON lists no tiles');
  const all = (z) => [...new Map(areas.flatMap((b) => tileRange(b, z)).map((t) => [t.join('/'), t])).values()];
  let z = 10;
  while (z > 6 && all(z).length > MAX_BASEMAP_TILES) z--;
  const list = all(z);
  const dir = sharedCacheDir('basemap-tiles');
  const parts = [];
  let cached = 0;
  out.log(`Reading the rail track from ${list.length} basemap tile(s) at z${z}…`);
  for (const [tz, x, y] of list) {
    const url = tpl.replace('{z}', tz).replace('{x}', x).replace('{y}', y);
    const file = path.join(dir, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}.pbf`);
    let buf = null;
    try { if (Date.now() - fs.statSync(file).mtimeMs < TILE_CACHE_DAYS * 864e5) { buf = fs.readFileSync(file); cached++; } } catch {}
    if (!buf) {
      buf = (await fetchBuffer(url, { label: 'basemap tiles', retries: 2, timeoutMs: 20000 })).buf;
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); } catch {}
    }
    const t = decodeTile(buf, { z: tz, x, y, only: ['transportation'] });
    for (const f of t.transportation || []) {
      const p = f.properties || {};
      if (p.class !== 'rail' || f.type !== 'Line' || p.service || !['rail', 'narrow_gauge', undefined].includes(p.subclass)) continue;
      for (const c of f.parts) if (c.length >= 2) parts.push(c);
    }
  }
  const geom = buildGeom(parts, Math.max(simplify, 30));
  const features = geom ? [{ type: 'Feature', geometry: geom, properties: { id: 'basemap-rail', name: 'Railway', kind: 'rail', emoji: KIND_EMOJI.rail,
    source: 'OpenStreetMap via the basemap tiles (OpenFreeMap)', basemap: true, hsr_unknown: true } }] : [];
  return { features, z, tiles: list.length, cached };
}

const ARROW = /=>|→|->|⇒|<=>|↔/;
function relScore(t) {
  return (t.ref ? 2 : 0) + (englishOk(t['name:en']) ? 1 : 0) - (ARROW.test(t.name || '') ? 3 : 0) - (/[(（]/.test(t.name || '') ? 1 : 0);
}
function englishOk(n) { return !!n && !ARROW.test(n); }

function keepKind(kind, kinds) { return kinds.includes(kind) || (kind === 'hsr' && kinds.includes('rail')); }

function isHsr(t) {
  return t.highspeed === 'yes' || t.service === 'high_speed' || /high_speed/.test(t.train || '') ||
    HSR_NAME.test(`${stripDir(t.name || '')} ${stripDir(t['name:en'] || '')} ${t.network || ''} ${t.operator || ''} ${t.brand || ''}`);
}
function relKind(t) {
  switch (t.route) {
    case 'subway': return 'subway';
    case 'light_rail': case 'monorail': return 'light_rail';
    case 'tram': return 'tram';
    case 'train': return isHsr(t) ? 'hsr' : /tourism|heritage/.test(`${t.usage || ''} ${t.service || ''}`) ? 'heritage' : 'rail';
    case 'ferry': return 'ferry';
    default: return null;
  }
}
function wayKind(t) {
  if (t.railway === 'subway') return 'subway';
  if (t.railway === 'light_rail' || t.railway === 'monorail') return 'light_rail';
  if (t.railway === 'tram') return 'tram';
  if (t.railway === 'preserved' || ((t.railway === 'rail' || t.railway === 'narrow_gauge') && t.usage === 'tourism')) return 'heritage';
  if (t.railway === 'rail' || t.railway === 'narrow_gauge') return isHsr(t) ? 'hsr' : 'rail';
  if (t.route === 'ferry') return 'ferry';
  if (t.highway === 'cycleway' || (t.highway === 'path' && t.bicycle === 'designated')) return 'cycleway';
  return null;
}
// "Red Line: Tamsui → Xiangshan" → "Red Line"
function stripDir(name) { return name.replace(/\s*[:：(（].*$/, '').replace(/\s*(→|->|=>|⇒|—|–|-)\s.*$/, '').trim(); }

function buildGeom(parts, simplify) {
  const merged = mergeLines(parts).map((l) => simplifyLine(l, simplify)).filter((l) => l.length >= 2 && lineLengthM(l) > 5);
  if (!merged.length) return null;
  const rc = merged.map(roundCoords).map(dedupeConsecutive).filter((l) => l.length >= 2);
  if (!rc.length) return null;
  return rc.length === 1 ? { type: 'LineString', coordinates: rc[0] } : { type: 'MultiLineString', coordinates: rc };
}
function dedupeConsecutive(l) { return l.filter((c, i) => !i || c[0] !== l[i - 1][0] || c[1] !== l[i - 1][1]); }

function lineFeature(id, kind, t, geometry, extra) {
  const p = { id, name: stripDir(t.name || '') || t.ref || defaultName(kind) };
  const en = t['name:en'] ? stripDir(t['name:en']) : '';
  if (en && en !== p.name) p.name_en = en;
  if (t.ref) p.ref = t.ref;
  const c = normColour(t.colour || t['colour:back'] || '');
  if (c) p.colour = c;
  p.kind = kind;
  p.emoji = KIND_EMOJI[kind];
  if (t.network) p.network = t.network;
  if (t.operator) p.operator = t.operator;
  if (t.route && t.name && stripDir(t.name) !== t.name) p.full_name = t.name;
  Object.assign(p, extra);
  p.source = 'OpenStreetMap';
  return { type: 'Feature', geometry, properties: p };
}
function defaultName(kind) {
  return { subway: 'Metro line', light_rail: 'Light rail', tram: 'Tram', rail: 'Railway', hsr: 'High-speed rail', heritage: 'Heritage railway', ferry: 'Ferry', cycleway: 'Cycleway' }[kind];
}
function normColour(c) {
  c = String(c).trim();
  if (!c) return null;
  if (/^#?[0-9a-f]{6}$/i.test(c) || /^#?[0-9a-f]{3}$/i.test(c)) return (c.startsWith('#') ? c : '#' + c).toLowerCase();
  if (/^[a-z]{3,20}$/i.test(c)) return c.toLowerCase();
  return null;
}
