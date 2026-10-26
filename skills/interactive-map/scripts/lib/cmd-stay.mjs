// `station` and `stay`: the two steps of a multi-city trip that the hotel-choice path does not cover.
//   station  the main rail station of a city (the place search: OpenStreetMap railway=station objects only), one point per stop
//   stay     lodging ranked by walking time to a station or place, with a one-line reason each (Taiwan: the national
//            lodging register, data.gov.tw 7780; elsewhere OpenStreetMap tourism=hotel|hostel|guest_house|…)
// Neither command ever takes a coordinate from the model except one that geocode/station printed (--near).
import fs from 'node:fs';
import { parseArgs, makeOut, parseLngLat, haversine, round6, slugify, writeGeoJSON, writeJSON, readJSON, exists, UsageError, UserError } from './util.mjs';
import { openSite, checkLayerId, configLayer, layerPath, layerRelPath, resolvePoint, addAttribution, titleCase, viewCenter, withSiteLock } from './site.mjs';
import { isSkip, withCap, overpassBatch, partialLine } from './net.mjs';
import { geocodeSearch, countryMatches, forgetMissing, partialProps } from './cmd-geocode.mjs';
import { placesSearch } from './osm-places.mjs';
import { walkTable } from './route-lookups.mjs';
import { adapterFor } from '../adapters/lib/areas.mjs';

export const helps = {
  station: `station <dir> --city "<city>" [--country <name|code>] [--near lng,lat] [--layer stations] [--id <slug>] [--kind rail|hsr]
        [--nights N] [--pick N] [--max-km 20] [--json]
  The city's main railway station as a point (kind train_station, 🚉), from OpenStreetMap railway=station objects only
  (the place search with a station filter), so a weather station or a bus stop called "… Station" never wins. Ranked by:
  the name is the city ("Hualien", "花蓮", "Kyoto"), then a main/central name ("Amsterdam Centraal", "Lyon Part-Dieu"
  only on a tie), then the distance from --near (the city centre from geocode). --kind hsr prefers high-speed
  stations (高鐵, HSR, 新幹線, TGV…), which are often outside town. Without --near the city centre is looked up first
  (the place search near the map's view); --country makes that search name the country and keeps only hits in it
  (always pass it: many city names exist in several countries), and stations in other countries are dropped. When
  nothing carries the city's name, the centre's local-language name is tried too.
  --nights N sets "nights" on the point (plan-route counts the nights per stop).
  Prints the pick and the alternatives; --pick N takes alternative N. Upserts by id (default: the city slug) into
  data/<layer>.geojson (a layer written by station or add-point).`,
  stay: `stay <dir> --near <layer:id | lng,lat> [--near-label "the centre of <City>"] [--stop <id>] [--layer stays] [--radius 800]
     [--max 3] [--kinds hotel,hostel,bnb] [--prefer hotel|any|bnb] [--min-rooms 10] [--source auto|tw|osm] [--json]
  Lodging near a station (or any place) ranked by walking time, with a one-line reason each, into data/<layer>.geojson.
  Candidates: in Taiwan the national lodging register (data.gov.tw 7780: every licensed hotel and B&B with
  coordinates, open listings only; first download ~5 MB, cached 24 h), elsewhere OpenStreetMap tourism=hotel, motel,
  hostel, guest_house, apartment (the places chain: Overpass, else a partial reverse search). --source osm uses OpenStreetMap in Taiwan too.
  Walk: OSRM foot routing from --near to the nearest 10 candidates (straight line); when routing is busy it is
  "est." (straight line × 1.3 at 80 m/min). Rank: walk minutes; with --prefer hotel (default) + 3 for B&Bs and guest
  houses and + 2 for places with fewer than --min-rooms (10) registered rooms (a hotel 6 min away beats a 4-room B&B 4
  min away); --prefer any ranks by walk alone, --prefer bnb puts B&Bs first. --kinds hotel (default hotel,hostel; bnb
  is added when fewer than --max hotels are in range). A lng,lat --near is named by --near-label in the walk texts
  ("6 min walk to the centre of Hualien"), and --stop says which stop the picks belong to (default: the --near id).
  Each point gets: rank, why ("6 min walk (routed, 420 m) to Hualien Station · registered hotel, 120 rooms"), stop
  (the --near id), walk_min, walk_m, walk_basis, and in Taiwan licence + tw_* (rooms, class, FILED rates: not prices).
  Runs per stop: the points for that --near are replaced, the other stops' points stay. Exit 2 = nothing in range
  (widen --radius). Never a booking or a live price: say so in the reply.`,
};

// ---------------------------------------------------------------------------
// station
const HSR_RE = /高鐵|高铁|新幹線|新干线|high[ -]?speed|\bHSR\b|\bTHSR\b|\bKTX\b|\bTGV\b|\bICE\b|\bAVE\b|shinkansen/i;
const MAIN_RE = /\b(central|centraal|centrale|centrum|main|hauptbahnhof|hbf|termini|part-dieu|sentral)\b|中央|總站|总站/i;
const STATION_WORDS = /\s*(railway station|train station|main station|central station|station|stn\.?|gare( de)?|bahnhof|estación|stazione)\s*/gi;
export function normPlace(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/\(.*?\)/g, '').replace(STATION_WORDS, ' ')
    .replace(/(火車站|火车站|車站|车站|駅|站)$/u, '').replace(/^(臺|台)/u, '台').replace(/[,.'’\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const cityOnly = (city) => normPlace(String(city).split(',')[0].replace(/\b(city|shi|si|county)\b/gi, '').replace(/[市縣县]$/u, ''));

/** Score station candidates for a city: higher is better. Exported for the tests. */
export function rankStations(cands, { city, kind = 'rail', near = null, maxKm = 20 }) {
  const want = cityOnly(city);
  const out = [];
  for (const c of cands) {
    const names = [c.name, c.name_en].filter(Boolean);
    const norm = names.map(normPlace);
    if (near && haversine(near, c.coord) > maxKm * 1000) continue;
    let s = 0;
    const exact = norm.some((n) => n === want);
    const contains = norm.some((n) => n.includes(want) || (want.length >= 2 && want.includes(n) && n.length >= 2));
    if (exact) s += 4; else if (contains) s += 1;
    if (names.some((n) => MAIN_RE.test(n)) && contains) s += 2;
    const hsr = !!c.hsr || names.some((n) => HSR_RE.test(n));
    if (kind === 'hsr') s += hsr ? 4 : 0; else if (hsr) s -= 3;
    if (near) s -= Math.min(3, haversine(near, c.coord) / 1000 * 0.12);
    out.push({ ...c, score: Math.round(s * 100) / 100, hsr });
  }
  // the same station mapped twice (node + building, two platforms): keep the best-ranked one
  out.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of out) if (!kept.some((k) => normPlace(k.name) === normPlace(c.name) && haversine(k.coord, c.coord) < 600)) kept.push(c);
  return kept;
}

function upsertPoints(site, layer, feats, { cmd, owners, replaceWhere }) {
  // read, merge and write under the site's write lock: another stop's command may write this layer at the same time
  return withSiteLock(site, () => {
    const p = layerPath(site, layer);
    let fc = { type: 'FeatureCollection', features: [] };
    if (exists(p)) {
      try { fc = readJSON(p); } catch (e) { throw new UserError(`${layerRelPath(site, layer)} is not valid JSON: ${e.message}`); }
      const owner = fc?.uw?.cmd;
      if (owner && !owners.includes(owner)) throw new UserError(`${layerRelPath(site, layer)} was written by "${owner}"; use another --layer (e.g. --layer ${cmd === 'stay' ? 'stays' : 'stations'}).`);
      if (!Array.isArray(fc.features)) fc.features = [];
    }
    if (replaceWhere) fc.features = fc.features.filter((f) => !replaceWhere(f));
    for (const f of feats) {
      const i = fc.features.findIndex((x) => String(x?.properties?.id) === String(f.properties.id));
      if (i >= 0) fc.features[i] = { ...f, properties: { ...fc.features[i].properties, ...f.properties } }; else fc.features.push(f);
    }
    fc.uw = { ...(fc.uw || {}), cmd: fc.uw?.cmd || cmd, updated_at: new Date().toISOString() };
    writeGeoJSON(p, fc);
    return { rel: layerRelPath(site, layer), count: fc.features.length };
  });
}

function registerPoints(site, layer, def) {
  if (configLayer(site, layer)) return null;
  return withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    if ((cfg.layers || []).some((l) => l?.id === layer)) { site.config = cfg; return null; }
    cfg.layers = [...(Array.isArray(cfg.layers) ? cfg.layers : []), { id: layer, title: titleCase(layer), type: 'points', data: layerRelPath(site, layer), ...def }];
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    return `map.config.json: registered layer "${layer}" (points).`;
  });
}

/** "Tainan HSR" for a high-speed station whose English name is just the city (or missing). Pure; for the tests. */
export function hsrEnglishName(nameEn, city) {
  const base = nameEn || city;
  return HSR_RE.test(base) ? base : `${String(base).replace(/\s*(railway\s+|train\s+)?station$/i, '')} HSR`;
}

/** A station far from the town centre (Hualien: about a 30-minute walk) makes "stay by the station" a poor default
 *  for a stop with full days: say so, with the command for stays in the centre. Null when it is close, a
 *  pass-through, or the place is a big municipality (its outline over 30 km across, `extentKm`): there Photon's point
 *  is the city hall (Taipei: Xinyi, 4.8 km from Taipei Main; Taichung: Xitun), not where visitors walk, so the
 *  distance says nothing. In a town Photon's point sits between the station and the old centre (Hualien: 1.3 km
 *  of a 2 km walk), so a short threshold. Pure; exported for the tests. */
export function farFromCentreAdvice(city, centreKm, nights, centre, dir = '<site>', extentKm = null) {
  if (extentKm > BIG_PLACE_KM) return null;
  if (!(centreKm > FAR_FROM_CENTRE_KM) || !(nights == null || nights >= 2)) return null;
  const walk = Math.round((centreKm * 1000 * DETOUR_STATION) / 80 / 5) * 5;
  return `FAR FROM THE CENTRE: the station is ${centreKm.toFixed(1)} km (about ${walk} min walk) from ${city}'s centre (stays in town: uw stay ${dir} --near ${centre.join(',')} --near-label "the centre of ${city}" --stop <this station's id>).`;
}
const DETOUR_STATION = 1.3;
/** A station further than this from its town's centre is flagged (a fact; what to do about it is the skill's call). */
export const FAR_FROM_CENTRE_KM = 1.2;
const BIG_PLACE_KM = 30;

export async function station(argv) {
  const args = parseArgs(argv, { city: 'string', near: 'string', layer: 'string', id: 'string', kind: 'string', nights: 'number', pick: 'number', 'max-km': 'number', country: 'string' },
    { positionals: [1, 1], command: 'station' });
  if (args.help) return console.log(helps.station);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  if (!args.city) throw new UsageError('station needs --city "<city name>" (e.g. --city Hualien)');
  const layer = checkLayerId(args.layer || 'stations');
  const kind = (args.kind || 'rail').toLowerCase();
  if (!['rail', 'hsr'].includes(kind)) throw new UsageError('--kind must be rail or hsr');
  if (args.nights != null && !(Number.isInteger(args.nights) && args.nights >= 0 && args.nights <= 60)) throw new UsageError('--nights must be a whole number 0-60');
  const city = String(args.city).split(',')[0].trim();
  let near = args.near ? parseLngLat(args.near, 'near') : null;
  let searchCentre = null; // the city centre the place search found (not the map's view): the station's distance to town
  let centreExtentKm = null; // how big that place is: a big municipality's point is its city hall
  let centreCountry = null; // its ISO country code: stations elsewhere are not candidates
  let localName = null; // the centre's name in the local language, for a second station search
  if (!near) {
    // no --near: the city's own centre (the place search, place objects only), biased to the map's view; saves a geocode step.
    // With --country the query names the country and only hits in it count (Tokyo is also a village in Papua New Guinea).
    const placeTags = ['place:city', 'place:town', 'place:municipality', 'place:county', 'place:village', 'place:suburb'];
    const centreQuery = args.country && !String(args.city).includes(',') ? `${args.city}, ${args.country}` : String(args.city);
    try {
      // the first tag set has a next step of its own (the province tags); the English one only adds country names
      const lookup = (tags, onEmpty = null) => Promise.all([
        geocodeSearch(centreQuery, { near: viewCenter(site), limit: 5, tags, onEmpty }),
        args.country ? geocodeSearch(centreQuery, { near: viewCenter(site), limit: 5, lang: 'en', tags, onEmpty: 'stop' }) : Promise.resolve([]),
      ]);
      let [local, en] = await lookup(placeTags, 'stop');
      // a capital that is mapped as its own state or province (東京都 is place=province; Berlin, Vienna are states)
      if (!local.length) [local, en] = await lookup(['place:state', 'place:province', 'place:region']);
      for (const c of local) { const m = en.find((e) => e.osm_id && e.osm_id === c.osm_id); if (m?.country && m.country !== c.country) c.country_en = m.country; }
      const hits = args.country ? local.filter((c) => countryMatches(c, args.country) !== false) : local;
      if (args.country && local.length && !hits.length) {
        out.result({ ok: false, layer, city, country: args.country, candidates: [] }, [`No place named "${city}" in ${args.country} (found: ${[...new Set(local.map((c) => c.country_en || c.country).filter(Boolean))].join(', ')}).`,
          'Check the spelling or use the local-language name; the stop was not placed.']);
        return 2;
      }
      if (hits[0]) {
        near = hits[0].coord; searchCentre = hits[0].coord; centreExtentKm = hits[0].extent_km ?? null; centreCountry = hits[0].countrycode || null; localName = hits[0].name;
        out.log(`City centre: ${hits[0].name}${hits[0].address ? ` (${hits[0].address})` : ''} @ ${near.join(',')}`);
      }
    } catch (e) { if (isSkip(e)) throw e; }
    near = near || viewCenter(site);
  }
  const tags = ['railway:station', 'railway:halt'];
  const queries = kind === 'hsr' ? [`${city} HSR`, city] : [city];
  const byId = new Map();
  // the English search only adds names to what the local one finds: an empty answer there asks no fallback
  const ask = (q, lang, t = tags) => geocodeSearch(q, { near, limit: 12, lang, tags: t, onEmpty: lang === 'en' ? 'stop' : null }).catch((e) => { if (isSkip(e)) throw e; out.warn(`place search (${lang}): ${e.message}`); return []; });
  const lists = await Promise.all(queries.flatMap((q) => [ask(q, 'default').then((l) => ['default', l]), ask(q, 'en').then((l) => ['en', l])]));
  for (const [lang, list] of lists.sort((a, b) => (a[0] === 'default' ? -1 : 1) - (b[0] === 'default' ? -1 : 1))) {
    for (const c of list) {
      const k = c.osm_id || c.coord.join(',');
      const prev = byId.get(k);
      if (lang === 'en') { if (prev) { if (c.name && c.name !== prev.name) prev.name_en = c.name; } else byId.set(k, { ...c, name_en: c.name }); }
      else if (!prev) byId.set(k, { ...c });
    }
  }
  const maxKm = args['max-km'] ?? 20;
  // nothing named like the city: search once more by the centre's local-language name (花蓮 for Hualien, 東京 for Tokyo)
  if (localName && normPlace(localName) !== normPlace(city) && !(rankStations([...byId.values()], { city, kind, near, maxKm })[0]?.score > 0)) {
    out.log(`Tried "${localName}" (the local name of ${city}) too.`);
    for (const c of await ask(localName, 'default')) if (!byId.has(c.osm_id || c.coord.join(','))) byId.set(c.osm_id || c.coord.join(','), { ...c });
  }
  const sameCountry = (c) => !centreCountry || !c.countrycode || c.countrycode === centreCountry;
  const pool = [...byId.values()].filter(sameCountry);
  let ranked = rankStations(pool, { city, kind, near, maxKm });
  if (localName && !(ranked[0]?.score > 0)) {
    const byLocal = rankStations(pool, { city: localName, kind, near, maxKm });
    if ((byLocal[0]?.score ?? -Infinity) > (ranked[0]?.score ?? -Infinity)) ranked = byLocal;
  }
  // High-speed stations often carry the plain city name (台南 for THSR Tainan): when the pick is ambiguous, objects next
  // to a station whose names say high-speed (高鐵台南站 bus stop, "Taichung HSR" parking) mark it
  const top = ranked.filter((c) => c.score >= ranked[0]?.score - 2);
  if (ranked.length && (kind === 'hsr' || top.length > 1) && !ranked.some((c) => c.hsr && kind === 'hsr')) {
    const locals = [...new Set(ranked.slice(0, 3).map((c) => normPlace(c.name)).filter((n) => /\p{Script=Han}/u.test(n)))].slice(0, 2);
    const hq = [`${city} HSR`, ...locals.map((n) => `高鐵${n}`)];
    const hints = (await Promise.all(hq.map((q) => ask(q, 'default', [])))).flat().filter((h) => HSR_RE.test(h.name));
    let changed = false;
    for (const c of ranked) if (!c.hsr && hints.some((h) => haversine(h.coord, c.coord) < 600)) { c.hsr = true; c.hsr_hint = true; changed = true; }
    if (changed) ranked = rankStations(ranked.map(({ score, ...c }) => c), { city, kind, near, maxKm });
  }
  if (!ranked.length) {
    out.result({ ok: false, layer, city, candidates: [] }, [`No railway station named like "${city}" within ${maxKm} km${near ? ' of --near' : ''}.`,
      `Try the name on the station sign (--city "<that name>"), pass --country, check --near, or: uw add-point ${args._[0]} --layer ${layer} --query "<station name>" --near <lng,lat> --kind train_station`]);
    return 2;
  }
  const idx = args.pick != null ? args.pick - 1 : 0;
  if (!(idx >= 0 && idx < ranked.length)) throw new UsageError(`--pick ${args.pick}: there are ${ranked.length} candidates`);
  const c = ranked[idx];
  // --kind hsr must not quietly write the conventional station (Kaohsiung → 高雄車站 instead of Zuoying)
  if (kind === 'hsr' && !c.hsr && args.pick == null) {
    out.result({ ok: false, layer, city, kind, candidates: ranked.slice(0, 5).map((x) => ({ name: x.name, name_en: x.name_en, coord: x.coord, score: x.score })) },
      [`No high-speed station found for "${city}" (none of the candidates is marked high-speed). Its high-speed station may carry another name (often the district it is in): try --city "<that name>", or take a candidate with --pick N.`,
        ...ranked.slice(0, 5).map((x, i) => `  ${i + 1}. ${x.name}${x.name_en && x.name_en !== x.name ? ` (${x.name_en})` : ''} @ ${x.coord.join(',')}`)]);
    return 2;
  }
  const id = slugify(args.id || city) || slugify(c.name_en || '') || `station-${idx + 1}`;
  // an HSR station's English name says so ("Tainan HSR"), so a leg card never reads "Tainan → Tainan"
  const nameEn = c.hsr ? hsrEnglishName(c.name_en && c.name_en !== c.name ? c.name_en : null, city) : (c.name_en && c.name_en !== c.name ? c.name_en : null);
  const centre = searchCentre;
  const centreKm = centre ? haversine(centre, c.coord) / 1000 : null;
  const props = { id, name: c.name, ...(nameEn ? { name_en: nameEn } : {}), kind: 'train_station', emoji: c.hsr ? '🚄' : '🚉',
    station_of: city, station_kind: c.hsr ? 'hsr' : 'rail', osm_id: c.osm_id || undefined, address: c.address || undefined, source: c.source || 'OpenStreetMap',
    // found by a fallback source (the first search was down or found nothing): the point says so
    ...partialProps(c),
    ...(args.nights != null ? { nights: args.nights } : {}),
    ...(centreKm != null && !(centreExtentKm > BIG_PLACE_KM) ? { centre_km: Math.round(centreKm * 10) / 10, centre_lnglat: centre.map(round6) } : {}) };
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  const farLine = centreKm != null ? farFromCentreAdvice(city, centreKm, args.nights, centre.map(round6), args._[0], centreExtentKm) : null;
  const feat = { type: 'Feature', geometry: { type: 'Point', coordinates: c.coord.map(round6) }, properties: props };
  const w = upsertPoints(site, layer, [feat], { cmd: 'station', owners: ['station', 'add-point'] });
  // an earlier lookup that failed listed the stop as "Not found yet" (handoff --apply's first pass): it is on the map now
  forgetMissing(site, { layer, id, name: city, query: city });
  const reg = registerPoints(site, layer, { tier: 'support', style: { emoji: '🚉', color: '#475569' }, list: true });
  addAttribution(site, '© OpenStreetMap contributors (ODbL)');
  const fmt = (x, i) => `${i === idx ? '*' : ' '} ${i + 1}. ${x.name}${x.name_en && x.name_en !== x.name ? ` (${x.name_en})` : ''}${x.hsr ? ' [high-speed]' : ''} @ ${x.coord.join(',')}` +
    `${near ? ` (${(haversine(near, x.coord) / 1000).toFixed(1)} km from --near)` : ''} score ${x.score}`;
  const partialNote = c.data_status === 'partial' ? partialLine(`${layer}:${id} ${c.name}`, c.data_reason || 'found by a fallback source', 'check the station on the map; re-run this station later for the full answer') : null;
  if (partialNote) console.error(partialNote);
  out.result({ ok: true, ...(partialNote ? { status: 'partial', partial: partialNote } : { status: 'ok' }), layer, file: w.rel, feature: props, coord: feat.geometry.coordinates, candidates: ranked.slice(0, 5).map((x) => ({ name: x.name, name_en: x.name_en, coord: x.coord, score: x.score, hsr: x.hsr })), registered: reg },
    [`Added ${layer}:${id} — ${props.emoji} ${c.name}${props.name_en ? ` (${props.name_en})` : ''} @ ${feat.geometry.coordinates.join(',')}${args.nights != null ? ` · ${args.nights} night(s)` : ''}`,
      farLine,
      ranked.length > 1 ? 'Alternatives (--pick N):' : null, ...(ranked.length > 1 ? ranked.slice(0, 5).map(fmt) : []), reg]);
  return 0;
}

// ---------------------------------------------------------------------------
// stay
const OSM_LODGING = { hotel: 'hotel', motel: 'hotel', hostel: 'hostel', guest_house: 'bnb', apartment: 'bnb' };
const KIND_WORD = { hotel: 'hotel', tourist_hotel: 'tourist hotel', bnb: 'B&B', hostel: 'hostel', guest_house: 'guest house', apartment: 'apartment', motel: 'motel' };
const WALK_M_PER_MIN = 80, DETOUR = 1.3;
export const HOSTEL_NAME = /青年旅舍|青旅|背包|膠囊|hostel|backpacker|capsule/i;

/** A lodging pick's kind as the map labels it. A register files many hostels as hotels, so the name decides too:
 *  the Places list and the reply must agree with the "a hostel by its name" the pick's why says. */
export function stayKind(c) {
  if (c.group === 'bnb') return 'guest_house';
  if (c.osm_kind === 'hostel' || HOSTEL_NAME.test(`${c.name} ${c.name_en || ''}`)) return 'hostel';
  return 'hotel';
}

/** Rank lodging candidates by walk minutes with small penalties; adds rank + why. Exported for the tests. */
export function rankStays(cands, { max = 3, to = 'the station', prefer = 'hotel', minRooms = 10 } = {}) {
  const scored = cands.map((c) => {
    let pen = 0;
    // --prefer hotel (default): a B&B or a very small place ranks a few minutes' walk behind a hotel; --prefer any
    // ranks by walk alone (a couple who want character); --prefer bnb ranks B&Bs first
    if (prefer === 'hotel' && c.group === 'bnb') pen += 3;
    if (prefer === 'bnb' && c.group !== 'bnb') pen += 3;
    if (prefer === 'hotel' && c.rooms != null && c.rooms < minRooms) pen += 2;
    return { ...c, score: c.walk_min + pen };
  }).sort((a, b) => a.score - b.score || a.walk_m - b.walk_m);
  // one per building: two listings within 30 m are usually one hotel registered twice (仟台 / 千台) or two floors
  const kept = [];
  for (const c of scored) { if (kept.length >= max) break; if (!kept.some((k) => haversine(k.coord, c.coord) < 30)) kept.push(c); }
  return kept.map((c, i) => {
    const walk = `${c.walk_min} min walk (${c.walk_basis === 'routed' ? 'routed' : 'est.'}, ${c.walk_m} m) to ${to}`;
    const hostelByName = c.registered && HOSTEL_NAME.test(`${c.name} ${c.name_en || ''}`);
    const what = c.registered
      ? `registered ${KIND_WORD[c.cls] || 'hotel'}${hostelByName ? ' (a hostel by its name)' : ''}${c.rooms ? `, ${c.rooms} rooms` : ''}`
      : `${KIND_WORD[c.osm_kind] || 'hotel'} in OpenStreetMap${c.stars ? `, ${c.stars}★ (OSM tag)` : ''}`;
    return { ...c, rank: i + 1, why: `${walk} · ${what}` };
  });
}

async function twCandidates(at, radius) {
  const { makeAdapterCtx } = await import('./cmd-adapter.mjs');
  const { nearby, NATIONAL } = await import('../adapters/tw-hotels.mjs');
  const { hasLatin } = await import('../adapters/lib/twnorm.mjs');
  const ctx = makeAdapterCtx({ name: 'tw-hotels', log: (l) => console.error(l) });
  const res = await nearby(ctx, { at, radius_m: radius, max: 80 });
  return {
    as_of: res.national_as_of, source: NATIONAL, total: res.total,
    list: res.items.map((it) => {
      const r = it.row; const en = (r.alt || []).find(hasLatin) || null;
      return { name: r.name, name_en: en, coord: [r.lng, r.lat], cls: it.cls.key || 'hotel', group: it.cls.key === 'bnb' ? 'bnb' : 'hotel', rooms: r.rooms ?? null,
        registered: true, tw_hotel_id: r.id, licence: r.lic || null, tw_price_min: r.pmin ?? null, tw_price_max: r.pmax ?? null, address: r.address || null, website: r.web || null,
        key: `tw-${String(r.id).replace(/^Hotel_/, '').toLowerCase()}` };
    }),
  };
}
/** The Overpass query for named lodging within `radius` m of a point (what `stay` asks OpenStreetMap). */
export const lodgingQuery = ([lng, lat], radius) =>
  `nwr["tourism"~"^(hotel|motel|hostel|guest_house|apartment)$"]["name"](around:${Math.round(radius)},${lat},${lng});\nout center tags 200;`;
const LODGING_TIMEOUT_S = 40;

/** Ask OpenStreetMap for the lodging around several anchors in one batched request and keep each answer in the cache,
 *  so the `stay` commands that follow (one per anchor, possibly side by side) are answered from disk. Anchors an
 *  official lodging register covers are left out (stay asks the register there). Resolves how many were asked and
 *  answered; never throws (a stay that finds nothing cached asks the usual way). */
export async function prefetchLodging(points, { radius = 800 } = {}) {
  const qs = points.filter((p) => Array.isArray(p) && !adapterFor('lodging-register', p)).map((p) => lodgingQuery(p, radius));
  if (qs.length < 2) return { asked: 0, answered: 0 };
  const r = await overpassBatch(qs, { timeoutS: LODGING_TIMEOUT_S }).catch((e) => Object.assign(qs.map(() => null), { unavailable: { asked: qs.length, reason: e.message } }));
  return { asked: qs.length, answered: r.filter((x) => x && !x.unavailable).length, unavailable: r.unavailable || null };
}

async function osmCandidates(at, radius, out) {
  const q = lodgingQuery(at, radius);
  // the places chain: Overpass; while it cannot answer, a reverse search lists named hotels, hostels and guest houses
  // (≤ 50 each), enough to rank the closest (partial); neither can answer = exit 4 (unavailable)
  const got = await placesSearch({ query: q, timeoutS: LODGING_TIMEOUT_S, reserveMs: 12000,
    reverse: { points: [at], radiusM: radius, tags: ['tourism:hotel', 'tourism:hostel', 'tourism:guest_house'].map((tag) => ({ tag })) } });
  const els = got.elements;
  let partial = null;
  if (got.status === 'partial') {
    out.warn(`${got.fallbackFor.join('; ') || 'Overpass could not answer'}; lodging from ${got.label} (partial)`);
    partial = `Overpass could not answer: lodging from ${got.label} (named hotels, hostels and guest houses only)`;
  }
  const list = [];
  for (const e of els) {
    const c = e.type === 'node' ? [e.lon, e.lat] : e.center ? [e.center.lon, e.center.lat] : null;
    const t = e.tags || {};
    if (!c || !t.name) continue;
    const kind = t.tourism;
    list.push({ name: t.name, name_en: t['name:en'] || null, coord: [round6(c[0]), round6(c[1])], osm_kind: kind, group: OSM_LODGING[kind] || 'hotel', rooms: Number(t.rooms) || null,
      stars: /^\d(\.\d)?S?$/.test(t.stars || '') ? String(t.stars).replace(/S$/, '') : null, website: t.website || t['contact:website'] || null,
      osm_id: `osm-${e.type[0]}${e.id}`, key: `osm-${e.type[0]}${e.id}` });
  }
  return { list, partial };
}

/** A routed walk from a station point can start on the wrong side of the tracks (OSRM snaps the one OSM node to the
 *  nearest footway, often behind the platforms) and send a hotel right outside the main exit round the block. A station
 *  has a way through, so when the route is over 2.5× the straight line (and the place is over 150 m away) the
 *  straight-line estimate stands, marked "est.". Pure; exported for the tests. */
export function reconcileStationWalk(c, straightM) {
  if (c.walk_basis !== 'routed' || straightM < 150 || c.walk_m <= straightM * 2.5) return c;
  c.walk_m = Math.round(straightM * DETOUR);
  c.walk_min = Math.max(1, Math.round((straightM * DETOUR) / WALK_M_PER_MIN));
  c.walk_basis = 'est.';
  c.walk_note = 'the routed walk went round the station; straight-line estimate';
  return c;
}

/** Walking minutes/metres from `from` to each candidate: OSRM foot table, else a straight-line estimate. */
async function walkTimes(from, cands, out, { fromStation = false } = {}) {
  for (const c of cands) {
    const d = haversine(from, c.coord);
    c.walk_m = Math.round(d * DETOUR); c.walk_min = Math.max(1, Math.round((d * DETOUR) / WALK_M_PER_MIN)); c.walk_basis = 'est.';
  }
  if (!cands.length) return 0;
  try {
    const t = await walkTable(from, cands.map((c) => c.coord), { retries: 1, timeoutMs: 25000 });
    if (t.code !== 'Ok') { out.warn(`OSRM said ${t.code}: walks are estimates`); return 0; }
    let n = 0;
    cands.forEach((c, i) => {
      const dur = t.durations?.[0]?.[i + 1], dist = t.distances?.[0]?.[i + 1];
      if (dur == null) return;
      c.walk_min = Math.max(1, Math.round(dur / 60)); c.walk_m = Math.round(dist ?? c.walk_m); c.walk_basis = 'routed'; n++;
      if (fromStation) { reconcileStationWalk(c, haversine(from, c.coord)); if (c.walk_basis !== 'routed') n--; }
    });
    return n;
  } catch (e) {
    if (isSkip(e)) { out.warn(`routing unavailable or out of time (${e.message}): walks are straight-line estimates`); return 0; }
    out.warn(`walking times: ${e.message}; walks are straight-line estimates`);
    return 0;
  }
}

export async function stay(argv) {
  const args = parseArgs(argv, { near: 'string', layer: 'string', radius: 'number', max: 'number', kinds: 'string', source: 'string',
    'near-label': 'string', stop: 'string', prefer: 'string', 'min-rooms': 'number' }, { positionals: [1, 1], command: 'stay' });
  if (args.help) return console.log(helps.stay);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  if (!args.near) throw new UsageError('stay needs --near <layer:id> (a station from `uw station`) or lng,lat from geocode');
  const anchor = resolvePoint(site, args.near, 'near');
  const layer = checkLayerId(args.layer || 'stays');
  const radius = args.radius ?? 800;
  if (!(radius >= 100 && radius <= 3000)) throw new UsageError('--radius must be 100-3000 m');
  const max = args.max ?? 3;
  if (!(Number.isInteger(max) && max >= 1 && max <= 8)) throw new UsageError('--max must be 1-8');
  const kinds = new Set((args.kinds || 'hotel,hostel').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  for (const k of kinds) if (!['hotel', 'hostel', 'bnb'].includes(k)) throw new UsageError(`--kinds: unknown "${k}" (hotel, hostel, bnb)`);
  const source = (args.source || 'auto').toLowerCase();
  if (!['auto', 'tw', 'osm'].includes(source)) throw new UsageError('--source must be auto, tw or osm');
  // an official lodging register where one covers the stop (adapters/lib/areas.mjs), else OpenStreetMap
  const tw = source === 'tw' || (source === 'auto' && !!adapterFor('lodging-register', anchor.coord));
  // a coordinate anchor is named by --near-label ("the centre of Hualien"), never by its numbers: walk texts are read
  // by people
  const toName = args['near-label'] || anchor.feature?.properties?.name_en || (anchor.id ? anchor.name : null) || 'the chosen point';
  const stop = slugify(args.stop || '') || anchor.id || slugify(args['near-label'] || '') || 'here';
  const nearRef = String(args.near).trim();
  const prefer = (args.prefer || 'hotel').toLowerCase();
  if (!['hotel', 'any', 'bnb'].includes(prefer)) throw new UsageError('--prefer must be hotel, any or bnb');
  const minRooms = args['min-rooms'] ?? 10;

  let got, srcLabel, srcUrl, attribution, asOf = null;
  if (tw) {
    try {
      const r = await twCandidates(anchor.coord, radius);
      got = { list: r.list, total: r.total, partial: null }; asOf = r.as_of;
      srcLabel = `Taiwan lodging register (data.gov.tw 7780${asOf ? `, as of ${asOf}` : ''})`; srcUrl = r.source.page;
      attribution = '旅館資料：交通部觀光署 (data.gov.tw，政府資料開放授權條款第1版)';
    } catch (e) {
      if (isSkip(e) || source === 'tw') throw e;
      out.warn(`Taiwan lodging register unavailable (${e.message}); using OpenStreetMap`);
    }
  }
  if (!got) {
    got = await osmCandidates(anchor.coord, radius, out);
    srcLabel = 'OpenStreetMap'; srcUrl = 'https://www.openstreetmap.org/copyright'; attribution = '© OpenStreetMap contributors (ODbL)';
  }
  const isHostel = (c) => stayKind(c) === 'hostel';
  const wantGroup = (c) => (c.group === 'bnb' ? kinds.has('bnb') : isHostel(c) ? kinds.has('hostel') : kinds.has('hotel'));
  const dist = (c) => haversine(anchor.coord, c.coord);
  const byDist = (list) => list.sort((a, b) => dist(a) - dist(b));
  const pool = byDist(got.list.filter(wantGroup)).slice(0, 10);
  // B&Bs and guest houses are the fallback when fewer than --max hotels (distinct buildings) are in range
  const spare = kinds.has('bnb') ? [] : byDist(got.list.filter((c) => c.group === 'bnb')).slice(0, 4);
  if (!pool.length && !spare.length) {
    out.result({ ok: false, layer, near: args.near, radius, source: srcLabel, picks: [] },
      [`No lodging within ${radius} m of ${toName} in ${srcLabel}. Widen it: uw stay ${args._[0]} --near ${args.near} --radius ${Math.min(3000, radius * 2)}`]);
    return 2;
  }
  // route the closest by straight line (one OSRM table request for all of them)
  const fromStation = anchor.feature?.properties?.kind === 'train_station';
  const routed = await walkTimes(anchor.coord, [...pool, ...spare], out, { fromStation });
  let picks = rankStays(pool, { max, to: toName, prefer, minRooms });
  let addedBnb = false;
  if (picks.length < max && spare.length) { picks = rankStays([...pool, ...spare], { max, to: toName, prefer, minRooms }); addedBnb = picks.some((c) => c.group === 'bnb'); }
  // a Latin name helps the traveller search for the place (registers often only have the Chinese one): OpenStreetMap's
  // English name of the same lodging (the place search, ≤ 120 m away and lodging-tagged); never invented
  for (const c of picks) {
    if (c.name_en) continue;
    try {
      const hits = await withCap(6000, () => geocodeSearch(c.name, { near: c.coord, limit: 3, lang: 'en', onEmpty: 'stop', tags: ['tourism:hotel', 'tourism:hostel', 'tourism:guest_house', 'tourism:motel'] }));
      const h = hits.find((x) => haversine(x.coord, c.coord) <= 120 && /[A-Za-z]{3}/.test(x.name) && x.name !== c.name);
      if (h) { c.name_en = h.name; c.name_en_source = 'OpenStreetMap'; }
    } catch (e) { if (isSkip(e)) break; }
  }
  const now = new Date().toISOString();
  const used = new Set();
  const feats = picks.map((c) => {
    let id = `${stop}-${slugify(c.name_en || '') || c.key}`.slice(0, 60).replace(/-+$/, '');
    while (used.has(id)) id += '-2';
    used.add(id);
    const props = {
      id, name: c.name, ...(c.name_en && c.name_en !== c.name ? { name_en: c.name_en } : {}), kind: stayKind(c),
      emoji: stayKind(c) === 'hotel' ? '🏨' : '🛏️', stop, rank: c.rank, why: c.why, note: c.why,
      walk_min: c.walk_min, walk_m: c.walk_m, walk_basis: c.walk_basis, walk_to: toName, near_ref: nearRef,
      source: srcLabel, source_url: srcUrl, checked_at: now,
      ...(c.osm_id ? { osm_id: c.osm_id } : {}), ...(c.website ? { website: c.website } : {}), ...(c.address ? { address: c.address } : {}),
      ...(c.registered ? { tw_hotel_id: c.tw_hotel_id, ...(c.licence ? { licence_no: c.licence } : {}), tw_class: c.cls, ...(c.rooms ? { tw_rooms: c.rooms } : {}),
        ...(c.tw_price_min ? { tw_price_min: c.tw_price_min } : {}), ...(c.tw_price_max ? { tw_price_max: c.tw_price_max } : {}) } : {}),
      ...(c.stars ? { stars: c.stars } : {}),
    };
    return { type: 'Feature', geometry: { type: 'Point', coordinates: c.coord.map(round6) }, properties: props };
  });
  // a re-run replaces this stop's picks for the same anchor; picks near another anchor of the stop (the station and
  // the town centre) stay
  const sameAnchor = (f) => (f?.properties?.near_ref ? f.properties.near_ref === nearRef : !/^-?\d/.test(nearRef));
  const w = upsertPoints(site, layer, feats, { cmd: 'stay', owners: ['stay'], replaceWhere: (f) => f?.properties?.stop === stop && sameAnchor(f) });
  const reg = registerPoints(site, layer, { style: { emoji: '🏨' }, list: true });
  addAttribution(site, attribution);
  if (routed) addAttribution(site, 'Walking times: OSRM (FOSSGIS) on OpenStreetMap');
  const partialNote = got.partial ? `PARTIAL: ${got.partial}` : null;
  out.result({ ok: true, layer, file: w.rel, stop, near: { ref: args.near, name: toName }, radius, source: srcLabel, as_of: asOf, candidates: got.total ?? got.list.length,
    routed, partial: got.partial || null, picks: feats.map((f) => f.properties), registered: reg },
  [`${feats.length} stay(s) near ${toName} (${got.total ?? got.list.length} lodging places within ${radius} m; ${srcLabel}; walks ${routed ? 'routed (OSRM foot)' : 'estimated'}):`,
    ...feats.map((f) => `  ${f.properties.rank}. ${f.properties.name}${f.properties.name_en ? ` (${f.properties.name_en})` : ''} — ${f.properties.why}  [${layer}:${f.properties.id}]`),
    addedBnb ? `  (fewer than ${max} hotels in range: B&Bs and guest houses were included)` : null,
    partialNote, reg,
    'Tell the user: picks are by walking distance from public registers/OSM; no live prices or availability.']);
  return 0;
}
