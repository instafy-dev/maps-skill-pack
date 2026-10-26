// `geocode` and `add-point`: the "geocode" lookup chain (lookup-providers.json: OpenStreetMap search, then
// Wikipedia's article coordinates, then an OpenStreetMap name search, each asked only while the ones before could not
// answer); add-point appends/replaces a point in a layer file.
import { parseArgs, makeOut, parseLngLat, haversine, round6, slugify, readJSON, writeJSON, writeGeoJSON, exists, bboxAround, UsageError, UserError } from './util.mjs';
import { fetchJSON, overpass, isSkip, withCap, ask, lookupState, cacheFor, partialLine } from './net.mjs';
import { openSite, checkLayerId, layerPath, layerRelPath, configLayer, titleCase, viewCenter, viewBounds, withSiteLock } from './site.mjs';
import { emojiFor } from './kinds.mjs';
import { fitView } from './cmd-site.mjs';
import { isLodging, registrySearch, acceptable, fmtRegistryCand, registryProps, queryLabel, slugFor } from './registry-geo.mjs';
import { adapterFor, adapterNamedIn, adapterForArea } from '../adapters/lib/areas.mjs';

export const helps = {
  geocode: `geocode "<query>" [--near lng,lat] [--country <name|code>] [--limit 5] [--lang en|de|fr|default] [--source auto|osm|registry] [--json]
  Candidates from the place search (OpenStreetMap; lookup-providers.json lists who is asked, in order): name, type,
  address, [lng,lat], osm id, distance from --near. Exit 2 = nothing found (a better query may find it); exit 4 = the
  search is unavailable right now (not "no such place": say so, go on, offer a retry).
  Always pass --near (the city/area centre) to bias results; it does not filter. --country does filter: only hits in
  that country (ISO code like JP, or its name), so a city name shared across countries never lands in the wrong one.
  Taiwan lodging (hotel, hostel, 旅館, 飯店, 民宿 …): when the search has no good match, Taiwan's lodging registers
  (data.gov.tw 7780 + Taipei 135464) are searched too, by registered name, Taipei register name, website and listing name
  (--source registry: only them; --source osm: never; "photon" is an old name for osm).`,
  addPoint: `add-point <dir> --layer <id> --query "<q>" [--near lng,lat] [--id slug] [--name "Label"] [--emoji 🏨] [--note "…"]
          [--props '{"price":120}'] [--kind hotel] [--pick N] [--allow-far] [--allow-mismatch] [--max-km 8] [--lang en]
          [--source auto|osm|registry] [--tier option|support|context] [--no-fit] [--country <name|code>] [--strict-name] [--json]
add-point <dir> --layer <id> --osm osm-w940449133 [--id slug] [--name …]   (an exact OpenStreetMap object, e.g. one a refusal suggested)
add-point <dir> --layer <id> --at lng,lat --name "Label" [...]     (only for coordinates the user gave you)
  Not in OpenStreetMap under its name (new, renamed, small)? Geocode its street address instead:
    --query "<street address, district, city>" --name "<real name>" --props '{"source":"<where the address came from>"}'
  --name in Latin script also becomes name_en (the label English maps show); OSM's English name is kept as osm_name_en.
  Geocodes with the place search and appends (or replaces, same id) a point in data/<layer>.geojson. Prints the chosen match and
  the alternatives: check them. --pick N chooses candidate N (1-based) instead. A match farther than --max-km (default 8)
  from --near is refused (exit 2) unless --allow-far. Without --near the config's view.center is used as bias and the
  match must fall inside view.bounds (+50%) or --max-km of view.center. If no candidate's name resembles the query it is refused too (exit 2):
  check the list, then --pick N or --allow-mismatch. Query words that only name the area (the city, region or country
  the candidates are in) do not count as a name match. --strict-name: refuse unless a candidate's own name carries the
  query's name (use it for a researched place: a wrong hotel with the right reason is worse than "not found").
  --country: only candidates in that country (an ISO code like JP, or its name).
  Taiwan lodging (a hotel/hostel/旅館/飯店/民宿 query, --kind hotel, or a layer like "hotels", in Taiwan by --near or the
  view): when the search's match is missing, far or unsure, Taiwan's lodging registers are searched by name (registered name,
  Taipei register name, website, listing name): data.gov.tw 7780 coordinates + address + licence id, with "prov"
  (source, lane open, match confidence). High/medium matches are taken; low ones are listed (--source registry --pick N).
  --source osm never asks the registers; --source registry asks only them. Exit 4 = the search was unavailable (the
  place is listed as "Not found yet"; not a wrong name: do not retry with another query this turn).
  map.config.json: a new layer is registered (points; tier option for a layer named like hotels/options/stays, else
  support; --tier sets it), an option layer keeps the view framed on its points (uw fit; --no-fit skips), and a place
  that could not be added is listed under "missing" (shown as "Not found yet" on the map) until it is.`,
};


// Does a candidate's name plausibly match the query? Generic words (hotel, taipei, 飯店 …) do not count.
const GENERIC = new Set(('the a an of de la le el du des and at in by on hotel hotels inn hostel hostal motel resort suites suite residence ' +
  'apartments apartment house guesthouse guest lodge station metro mrt subway railway train restaurant cafe coffee bar pub night market street ' +
  'road rd st ave avenue lane alley park temple shrine museum gallery city center centre plaza tower building mall shop store international ' +
  'grand main central terminal new old north south east west branch').split(' '));
// City and country words are not listed here: they are taken from where the candidates are (areaWordsOf), any country.
const CJK_GENERIC = /飯店|酒店|旅館|旅店|商旅|旅社|民宿|車站|夜市|公園|大樓|中心|餐廳|咖啡|分店|門市/g;
// Place-type words in a query ("… Station", "… Hotel"): the match must be that type of object. Order matters (first wins).
const TYPE_WORDS = [
  { word: /\b(hotel|inn|hostel|motel|resort|guest ?house|ryokan)\b|飯店|酒店|旅館|商旅|民宿|旅店/i, ok: /^(tourism=(hotel|hostel|guest_house|motel|apartment|chalet|resort)|building=hotel|leisure=resort)$/,
    tags: ['tourism:hotel', 'tourism:hostel', 'tourism:guest_house', 'tourism:motel', 'tourism:apartment'] },
  { word: /\bnight ?market\b|夜市/i, ok: /^(amenity=marketplace|place=|landuse=(retail|commercial)|highway=(pedestrian|residential|living_street)|tourism=attraction)/,
    tags: ['amenity:marketplace', 'tourism:attraction', 'place:square'] },
  { word: /\b(train |railway |rail |mrt |metro |subway |hsr |bus )?station\b|車站|火車站|捷運站|駅/i, ok: /^(railway=(station|halt|stop)|public_transport=station|building=(train_station|transportation)|amenity=bus_station)$/,
    tags: ['railway:station', 'railway:halt', 'public_transport:station', 'amenity:bus_station'] },
  { word: /\bairport\b|機場|空港/i, ok: /^aeroway=/, tags: ['aeroway:aerodrome', 'aeroway:terminal'] },
  { word: /\b(museum|gallery)\b|博物館|美術館/i, ok: /^(tourism=(museum|gallery|attraction)|building=museum|amenity=arts_centre)$/, tags: ['tourism:museum', 'tourism:gallery'] },
  { word: /\b(temple|shrine)\b/i, ok: /^(amenity=place_of_worship|historic=|building=(temple|shrine|religious)|tourism=attraction)/, tags: ['amenity:place_of_worship'] },
  { word: /\buniversity\b|大學/i, ok: /^(amenity=(university|college)|building=university)$/, tags: ['amenity:university'] },
  { word: /\bhospital\b|醫院/i, ok: /^(amenity=(hospital|clinic)|building=hospital|healthcare=)/, tags: ['amenity:hospital'] },
];
export function queryType(q) { return TYPE_WORDS.find((t) => t.word.test(q)) || null; }
function stripType(q, t) { return q.replace(new RegExp(t.word.source, 'gi'), ' ').replace(/\s+/g, ' ').trim(); }

/** Does a candidate's name plausibly match the query? `area`: place names of where the candidates are (their city,
 *  district, county, state, country, in any language): a query word that only names the area ("Kindness Hotel
 *  Taitung" vs "Sheraton Taitung") is not evidence, whatever the country. Null when nothing distinctive is left. */
export function nameMatches(query, names, area = []) {
  const norm = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const q = norm(query);
  const hay = names.filter(Boolean).map(norm).join(' | ');
  const areaText = area.filter(Boolean).map(norm).join(' | ');
  const areaTokens = new Set(areaText.match(/[a-z0-9]+/g) || []);
  const latin = (q.match(/[a-z0-9]+/g) || []).filter((t) => (t.length >= 3 || /^\d+$/.test(t)) && !GENERIC.has(t) && !areaTokens.has(t));
  const cjk = (q.replace(CJK_GENERIC, ' ').match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]{2,}/g) || []);
  const bigrams = cjk.flatMap((w) => [...w].slice(0, -1).map((c, i) => c + w[i + 1])).filter((b) => !areaText.includes(b));
  if (!latin.length && !bigrams.length) return null; // nothing distinctive to compare
  const hayTokens = new Set(hay.match(/[a-z0-9]+/g) || []);
  return latin.some((t) => hayTokens.has(t) || [...hayTokens].some((h) => h.length >= 4 && (h.startsWith(t) || t.startsWith(h)))) ||
    bigrams.some((b) => hay.includes(b));
}

/** Wikipedia's coordinates for articles with these exact titles (redirects followed, disambiguation pages skipped):
 *  the quickest keyless answer for a city, a country or a main station. Candidates in the search's shape. */
async function wikipediaCoords(base, label, titles, { near, maxKm = null, type, kind, derivedFrom = titles.length, derivedMaxKm = null, cache = { cacheMaxAgeMs: 30 * 864e5 } }) {
  const u = new URL(`${base}/w/api.php`);
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', redirects: '1', prop: 'coordinates|pageprops', ppprop: 'disambiguation', coprimary: 'primary', titles: titles.join('|') })) u.searchParams.set(k, v);
  const data = await fetchJSON(u.toString(), { label, timeoutMs: 15000, retries: 1, statusRetries: 1, ...cache });
  const order = new Map(titles.map((t, i) => [t.toLowerCase(), i]));
  const redirected = new Map((data?.query?.redirects || []).map((r) => [String(r.to).toLowerCase(), String(r.from).toLowerCase()]));
  const out = [];
  for (const pg of Object.values(data?.query?.pages || {})) {
    const c = pg?.coordinates?.[0];
    if (!c || pg.pageprops?.disambiguation !== undefined || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const coord = [round6(c.lon), round6(c.lat)];
    const km = near ? haversine(near, coord) / 1000 : null;
    if (maxKm != null && km != null && km > maxKm) continue;
    const key = String(pg.title).toLowerCase();
    const i = order.get(key) ?? order.get(redirected.get(key)) ?? 99;
    // a title the query did not name ("Hualien City" for "Hualien"): only near where the map is
    if (i >= derivedFrom && (km == null || (derivedMaxKm != null && km > derivedMaxKm))) continue;
    out.push({ name: pg.title, type, kind, address: '', coord, osm_id: null, city: null, county: null, state: null, district: null, country: null, countrycode: null,
      ...(km != null ? { distance_km: Math.round(km * 100) / 100 } : {}), source: 'Wikipedia (its article\'s coordinates)',
      _i: i });
  }
  return out.sort((a, b) => a._i - b._i).map(({ _i, ...c }) => c);
}

/** How far from the map's centre a city found under a title the query did not name may lie (a country-wide map). */
const DERIVED_MAX_KM = 1500;

/** The Wikipedia titles to try for a name search, or null when an exact-title lookup cannot answer it (an address,
 *  a type search, a mixed-script name). */
function wikipediaQuery(q, { near, tags = [] }) {
  const raw = String(q || '').split(/[,，]/)[0].trim();
  const wantsPlace = tags.length ? tags.every((t) => /^(place|boundary):/.test(t)) : !near;
  const wantsStation = tags.length && tags.every((t) => /^railway:/.test(t));
  // a named sight near the stop ("Anping Fort", "Taroko Gorge") often has an article too
  const wantsNamed = !tags.length && near;
  if (raw.length < 2 || !(wantsPlace || wantsStation || wantsNamed) || !/^[\p{L}\p{N}\s'.-]+$/u.test(raw)) return null;
  // a city whose plain title is a disambiguation page (Hualien, Taitung: city or county) has its article as "<Name>
  // City" or "<Name>, <Country>" (Wikipedia's naming conventions); asked in the same request, taken only when the plain
  // title gives nothing and only within DERIVED_MAX_KM of the map (r10: both east-coast stops of every Taiwan run)
  const area = String(q || '').split(/[,，]/).slice(1).map((x) => x.trim()).filter(Boolean).pop();
  const derived = wantsPlace && near ? [`${raw} City`, ...(area && /^[\p{L}\s'.-]+$/u.test(area) ? [`${raw}, ${area}`] : [])] : [];
  const titles = wantsStation ? [`${raw} railway station`, `${raw} station`, `${raw} Station`] : [raw, ...derived];
  const opts = wantsStation ? { near, maxKm: 40, type: 'railway=station', kind: 'station' }
    : wantsPlace ? { near, type: 'place=city', kind: 'city', derivedFrom: 1, derivedMaxKm: DERIVED_MAX_KM } : { near, maxKm: 30, type: 'tourism=attraction', kind: 'attraction' };
  return { titles, opts };
}

/** The name search on OpenStreetMap through Overpass (the pack's mirrors, lock and backoff), in a box around `near`
 *  and limited to the asked tags (`railway:station`, `place:city`…); a town, a city or a country, or no area to
 *  search in: the exact place name world-wide. Candidates in the search's shape; they carry no country (Overpass has
 *  no address), so a country filter treats them as unknown, not foreign. Null when it cannot answer (no `near` for a
 *  type search). Exported for the tests. */
export async function overpassNameSearch(q, { near, limit = 5, lang, tags = [] } = {}) {
  const raw = String(q || '').split(/[,，]/)[0].trim();
  const placeTags = tags.length && tags.every((t) => /^(place|boundary):/.test(t));
  if (placeTags || (!near && !tags.length)) return overpassPlaceSearch(raw, { near, limit, lang });
  if (!near) return null;
  const name = raw.replace(/[\\".*+?^${}()|[\]]/g, '.');
  if (name.length < 2) return [];
  const area = tags.some((t) => /^(place|boundary):/.test(t)) ? 250000 : tags.some((t) => /^railway:/.test(t)) ? 40000 : 15000;
  const [w, s, e, n] = bboxAround(near, area);
  const box = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
  // places and stations are mapped as points: a node search is much lighter on a busy Overpass than nwr
  const filters = tags.length ? tags.map((t) => { const [k, v] = t.split(':'); return [/^(place|railway)$/.test(k) ? 'node' : 'nwr', `["${k}"${v ? `="${v}"` : ''}]`]; }) : [['nwr', '']];
  const keys = ['name', 'name:en'];
  const parts = filters.flatMap(([el, f]) => keys.map((k) => `${el}${f}["${k}"~"${name}",i]${box};`));
  // at most 30 s of the command's time: a busy Overpass must not hold one place for minutes
  const data = await withCap(30000, () => overpass(`(${parts.join('')});out center tags ${Math.max(20, limit * 4)};`, { timeoutS: 30 }));
  const want = name.toLowerCase();
  const seen = new Set();
  const cands = [];
  for (const el of data?.elements || []) {
    const t = el.tags || {};
    const lng = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !t.name) continue;
    const id = `osm-${String(el.type || 'n')[0]}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tag = tags.map((x) => x.split(':')).find(([k, v]) => t[k] && (!v || t[k] === v)) || ['railway', 'place', 'tourism', 'amenity', 'shop', 'leisure', 'historic'].map((k) => [k, t[k]]).find(([, v]) => v) || [];
    const coord = [round6(lng), round6(lat)];
    cands.push({
      name: lang === 'en' ? t['name:en'] || t.name : t.name,
      type: tag.length ? `${tag[0]}=${tag[1] ?? t[tag[0]]}` : '', kind: tag[1] ?? null,
      address: [t['addr:street'], t['addr:city']].filter(Boolean).join(', '), coord, osm_id: id,
      city: t['addr:city'] || null, county: null, state: null, district: null, country: null, countrycode: null,
      distance_km: Math.round(haversine(near, coord) / 10) / 100, source: 'OpenStreetMap (Overpass name search)',
      _exact: keys.some((k) => String(t[k] || '').toLowerCase() === want),
      // what a visitor looks for before a shop or office that carries the name ("Anping Fort Shop")
      _visit: t.tourism || t.historic || t.railway || t.place || t.leisure ? 0 : t.amenity ? 1 : 2,
    });
  }
  cands.sort((a, b) => (b._exact - a._exact) || a._visit - b._visit || a.distance_km - b.distance_km);
  return cands.slice(0, limit).map(({ _exact, _visit, ...c }) => c);
}

/** Places (country, region, city, town) whose name or English name is exactly `name`, world-wide, the most
 *  populous and nearest first. The search's candidate shape, like overpassNameSearch. */
async function overpassPlaceSearch(name, { near, limit = 5, lang } = {}) {
  if (!name || name.length < 2 || /["\\]/.test(name)) return [];
  const kinds = 'country|state|region|province|county|city|town|village|municipality';
  const keys = ['name', 'name:en'];
  const parts = [...keys.map((k) => `node["place"~"^(${kinds})$"]["${k}"="${name}"];`),
    ...keys.map((k) => `relation["boundary"="administrative"]["admin_level"~"^(2|4)$"]["${k}"="${name}"];`)];
  const data = await overpass(`(${parts.join('')});out center tags 40;`, { timeoutS: 60 });
  const rank = { country: 0, state: 1, region: 1, province: 1, city: 2, municipality: 3, county: 3, town: 4, village: 5 };
  const cands = [];
  const seen = new Set();
  for (const el of data?.elements || []) {
    const t = el.tags || {};
    const lng = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
    const id = `osm-${String(el.type || 'n')[0]}${el.id}`;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !t.name || seen.has(id)) continue;
    seen.add(id);
    const kind = t.place || (t.admin_level === '2' ? 'country' : 'state');
    const coord = [round6(lng), round6(lat)];
    cands.push({
      name: lang === 'en' ? t['name:en'] || t.name : t.name, type: t.place ? `place=${t.place}` : 'boundary=administrative', kind,
      address: '', coord, osm_id: id, city: null, county: null, state: null, district: null,
      country: kind === 'country' ? t['name:en'] || t.name : null, countrycode: t['ISO3166-1'] || t['country_code'] || null,
      ...(near ? { distance_km: Math.round(haversine(near, coord) / 10) / 100 } : {}),
      source: 'OpenStreetMap (Overpass name search)',
      _pop: Number(String(t.population || '').replace(/\D/g, '')) || 0, _rank: rank[kind] ?? 6,
    });
  }
  cands.sort((a, b) => a._rank - b._rank || b._pop - a._pop || (a.distance_km ?? 0) - (b.distance_km ?? 0));
  return cands.slice(0, limit).map(({ _pop, _rank, ...c }) => c);
}

/** How the "geocode" capability's protocols ask (lookup-providers.json names the providers and their order).
 *  A request is { q, near, limit, lang, tags }; each answers candidates in one shape. */
export const GEOCODE_PROTOCOLS = {
  'photon-search': {
    // slow rather than down at busy times (25-40 s an answer): one long attempt beats aborting and asking again;
    // 5xx still get a retry; a 429 never does (that service is not asked again this turn)
    async lookup({ q, near, limit = 5, lang, tags = [] }, p) {
      const u = new URL(`${p.base}/api/`);
      u.searchParams.set('q', q);
      for (const t of tags) u.searchParams.append('osm_tag', t);
      u.searchParams.set('limit', String(Math.max(1, Math.min(20, limit))));
      // the bias point to 3 decimals (~100 m): it only ranks results, and nearby asks share one cached answer
      if (near) { u.searchParams.set('lat', Number(near[1]).toFixed(3)); u.searchParams.set('lon', Number(near[0]).toFixed(3)); }
      if (lang && lang !== 'default') u.searchParams.set('lang', lang);
      const data = await fetchJSON(u.toString(), { label: p.label, timeoutMs: p.timeout_ms, retries: 1, statusRetries: 3, ...cacheFor(p, 30 * 864e5) });
      return (data.features || []).map((f) => toCandidate(f, near));
    },
  },
  'wikipedia-coords': {
    accepts: (req) => !!wikipediaQuery(req.q, req),
    async lookup(req, p) {
      const { titles, opts } = wikipediaQuery(req.q, req);
      return (await wikipediaCoords(p.base, p.label, titles, { ...opts, cache: cacheFor(p, 30 * 864e5) })).slice(0, req.limit ?? 5);
    },
  },
  'overpass-name': {
    accepts: ({ near, tags = [] }) => !!near || !tags.length || tags.every((t) => /^(place|boundary):/.test(t)),
    lookup: (req) => overpassNameSearch(req.q, req),
  },
};

/** The fields a candidate lacks that a full place search answer has (a name search on Overpass or Wikipedia's
 *  coordinates carry no address and no country). */
export function missingFields(c) {
  return [...(c.address ? [] : ['address']), ...(c.country || c.countrycode ? [] : ['country'])];
}

/** Candidates for a name or an address from the "geocode" chain: the first provider that could answer; an empty
 *  answer asks the next one (a small venue one search lacks, another may know). A provider that is down is skipped
 *  (its reason kept); none left = exit 4 (unavailable, not "no such place"). A fallback's candidates say where they
 *  came from and are marked partial: data_status "partial", via, data_reason, data_missing (fields they lack).
 *  onEmpty "stop": the caller has its own next step for an empty answer (an English duplicate, another tag set). */
export async function geocodeSearch(q, { near, limit = 5, lang, tags = [], onEmpty = null } = {}) {
  const r = await ask('geocode', { q, near, limit, lang, tags }, GEOCODE_PROTOCOLS, { onEmpty });
  const down = [...new Set(r.attempts.filter((a) => a.outcome === 'unavailable' || a.outcome === 'skipped_open' || a.outcome === 'skipped_budget').map((a) => a.label))];
  const empty = [...new Set(r.attempts.filter((a) => a.outcome === 'not_found').map((a) => a.label))];
  for (const c of r.results) {
    c.provider = r.provider;
    c.source = `${c.source || r.label}${down.length ? ` (${down.join(', ')} unavailable)` : ''}${empty.length ? ` (${empty.join(', ')} found nothing)` : ''}`;
    const missing = missingFields(c);
    if (missing.length) c.data_missing = missing;
    if (r.status === 'partial') {
      c.data_status = 'partial';
      c.via = r.provider;
      c.data_reason = [r.reason, missing.length ? `no ${missing.join(' or ')} from ${r.label}` : null].filter(Boolean).join('; ');
    }
  }
  return r.results;
}
/** The properties a point placed from a fallback's candidate carries until a full answer replaces it (empty for a
 *  complete candidate): data_status "partial", data_note ("… data may be incomplete"), data_missing. */
export function partialProps(c) {
  if (c?.data_status !== 'partial') return {};
  return { data_status: 'partial', data_note: `${c.data_reason || 'found by a fallback source'} (data may be incomplete)`, ...(c.data_missing?.length ? { data_missing: c.data_missing } : {}) };
}
/** The PARTIAL: line for candidates a fallback found (null when every one is complete). */
export function partialCandidatesLine(cands, what = 'place search') {
  const p = cands.filter((c) => c.data_status === 'partial');
  if (!p.length) return null;
  const why = [...new Set(p.map((c) => c.data_reason).filter(Boolean))].join('; ');
  return partialLine(what, why || 'answered by a fallback source', 'check the name and place on the map; a later retry may give the full answer');
}
/** The label of the place search as the person reads it ("OpenStreetMap search (Photon)"): its chain's first provider. */
const searchLabel = () => lookupState('geocode').providers[0]?.label || 'the place search';
/** --source: auto | osm (the search chain only; "photon" is its old name) | registry. */
function sourceArg(v) {
  const s = v === 'photon' ? 'osm' : v || 'auto';
  if (!['auto', 'osm', 'registry'].includes(s)) throw new UsageError('--source must be auto, osm or registry');
  return s;
}
/** Is the geocode chain's first provider down or slow right now? Then optional extra searches (English names, a
 *  town search) wait, and long jobs leave name lookups for later. */
export const geocodeDegraded = () => lookupState('geocode').degraded;
/** Is the geocode chain's first provider down right now (found down by any uw command, within its cooldown)? A long
 *  job then lists its remaining name lookups with their exact commands instead of a slow fallback per place. */
export const geocodeDown = () => { const first = lookupState('geocode').providers[0]; return !!first && !first.allow; };

/** The place names of where a list of candidates lies (for nameMatches' `area`). */
/** Is a candidate in `country` (an ISO 3166 alpha-2 code like "JP", or a name in English or the local language)? */
export function countryMatches(c, country) {
  const want = String(country || '').normalize('NFKC').trim().toLowerCase();
  if (!want) return true;
  if (/^[a-z]{2}$/.test(want) && c.countrycode) return c.countrycode.toLowerCase() === want;
  const names = [c.country, c.country_en].filter(Boolean).map((n) => String(n).normalize('NFKC').trim().toLowerCase());
  if (names.includes(want)) return true;
  // only a local-language country name (日本) and no English one to compare: cannot tell
  if (!c.country_en && c.country && !/^[\p{Script=Latin}\s'.-]+$/u.test(c.country)) return null;
  // no country at all (a name-search hit from a provider without addresses): unknown, not foreign
  if (!c.country && !c.country_en && !c.countrycode) return null;
  return false;
}

export function areaWordsOf(cands) {
  const words = [];
  for (const c of cands) words.push(c.city, c.district, c.county, c.state, c.country, c.district_en, c.city_en, c.state_en, c.country_en);
  return [...new Set(words.filter(Boolean))];
}

function toCandidate(f, near) {
  const p = f.properties || {};
  const coord = [round6(f.geometry.coordinates[0]), round6(f.geometry.coordinates[1])];
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const address = [street, p.district || p.locality, p.city || p.county, p.state, p.country].filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i).join(', ');
  const c = {
    name: p.name || street || p.city || '(unnamed)',
    type: [p.osm_key, p.osm_value].filter(Boolean).join('='),
    kind: p.osm_value || p.type || null,
    address,
    coord,
    osm_id: p.osm_type && p.osm_id ? `osm-${p.osm_type.toLowerCase()}${p.osm_id}` : null,
    city: p.city || p.county || null,
    county: p.county || null,
    state: p.state || null,
    district: p.district || p.locality || null,
    country: p.country || null,
    countrycode: p.countrycode ? String(p.countrycode).toUpperCase() : null,
  };
  // the size of the place's own outline (Photon "extent": [w, n, e, s]) as its diagonal in km: a big municipality's
  // point is its city hall, not where visitors walk
  if (Array.isArray(p.extent) && p.extent.length === 4 && p.extent.every(Number.isFinite)) {
    const [w, n, e, s] = p.extent;
    c.extent_km = Math.round(haversine([w, n], [e, s]) / 100) / 10;
  }
  if (near) c.distance_km = Math.round(haversine(near, coord) / 10) / 100;
  return c;
}

function fmtCand(c, i) {
  return `${i + 1}. ${c.name}${c.name_en && c.name_en !== c.name ? ` (${c.name_en})` : ''} [${c.type}]${c.via ? ' (type search)' : ''} ${c.address ? '— ' + c.address : ''} @ ${c.coord.join(',')}` +
    (c.distance_km != null ? ` (${c.distance_km} km away${c.far ? ', FAR from --near' : ''})` : '') + (c.osm_id ? ` ${c.osm_id}` : '');
}

export async function geocode(argv) {
  const args = parseArgs(argv, { near: 'string', limit: 'number', lang: 'string', source: 'string', country: 'string' }, { positionals: [1, 1], command: 'geocode' });
  if (args.help) return console.log(helps.geocode);
  const out = makeOut(args);
  const near = args.near ? parseLngLat(args.near, 'near') : null;
  const q = args._[0];
  if (!q.trim()) throw new UsageError('empty query');
  const source = sourceArg(args.source);
  // Taiwan lodging: the official registers (data.gov.tw 7780 + Taipei 135464) know hotels OpenStreetMap lacks
  // an official lodging register covers this area (adapters/lib/areas.mjs): by --near, else a place the query names
  const twArea = !!(near ? adapterFor('lodging-register', near) : adapterNamedIn('lodging-register', q));
  if (source === 'registry' && !twArea) throw new UsageError('--source registry: no lodging register covers this area (uw adapter list --at <lng,lat>); pass a --near inside one');
  let cands = [], searchErr = null;
  const goOn = (e) => { if (isSkip(e)) e.line = `skipped: ${e.message}. The place search is unavailable (not "no such place"). Go on without it: \`uw new <site>\` without --center, add the places (add-point; a lodging register answers where one covers the area), then \`uw fit <site>\` frames them. Never stop at the centre step.`; return e; };
  if (source !== 'registry') {
    try { cands = await geocodeSearch(q, { near, limit: args.limit ?? 5, lang: args.lang }); }
    catch (e) {
      // no centre is no reason to stop: the map is built without one and framed from its places
      if (!(source === 'auto' && twArea && isLodging({ query: q }))) throw goOn(e);
      searchErr = e;
    }
  }
  // "Hualien City" found a library, "Taitung City" a bike rental: for a town-like query, ask for places too and list them first
  const townish = !/\d/.test(q) && q.trim().split(/\s+/).length <= 3 && !queryType(q);
  if (source !== 'registry' && !searchErr && townish && !geocodeDegraded() && !cands.slice(0, 2).some((c) => /^(place|boundary)=/.test(c.type))) {
    try {
      const towns = await geocodeSearch(q.replace(/\b(city|town|county|district)\b/ig, '').trim() || q, { near, limit: 3, lang: args.lang, onEmpty: 'stop',
        tags: ['place:city', 'place:town', 'place:village', 'place:suburb', 'place:quarter', 'place:neighbourhood', 'place:county', 'boundary:administrative'] });
      const known = new Set(cands.map((c) => c.osm_id));
      const add = towns.filter((c) => !known.has(c.osm_id));
      cands = [...add, ...cands].slice(0, Math.max(args.limit ?? 5, add.length + 2));
    } catch { /* optional */ }
  }
  if (args.country && cands.length) {
    // English country names to compare with (one more search answer for the same query)
    if (!cands.some((c) => c.country_en) && !/^[a-z]{2}$/i.test(args.country.trim())) {
      try {
        const en = await geocodeSearch(q, { near, limit: args.limit ?? 5, lang: 'en', onEmpty: 'stop' });
        for (const c of cands) { const m = en.find((e) => e.osm_id && e.osm_id === c.osm_id); if (m?.country && m.country !== c.country) c.country_en = m.country; }
      } catch (e) { if (isSkip(e)) throw e; }
    }
    const kept = cands.filter((c) => countryMatches(c, args.country) !== false);
    if (!kept.length) {
      out.result({ ok: false, status: 'not_found', query: q, country: args.country, candidates: cands }, [`No result for "${q}" is in ${args.country} (found: ${[...new Set(cands.map((c) => c.country_en || c.country).filter(Boolean))].join(', ') || 'no country'}). Check the name or the country.`]);
      return 2;
    }
    cands = kept;
  }
  // --near biases the search but does not filter: matches within 50 km come first, far ones are flagged
  if (near) {
    const nearOnes = cands.filter((c) => c.distance_km <= 50), far = cands.filter((c) => !(c.distance_km <= 50));
    for (const c of far) c.far = true;
    cands = [...nearOnes, ...far];
  }
  let reg = null;
  const area = areaWordsOf(cands);
  const photonWeak = !cands.some((c) => !c.far && nameMatches(q, [c.name], area) !== false && (!queryType(q) || queryType(q).ok.test(c.type || '')));
  if (source === 'registry' || (source === 'auto' && twArea && isLodging({ query: q }) && photonWeak)) {
    try { reg = await registrySearch(q, { near, maxKm: 20, limit: args.limit ?? 5, log: (l) => console.error(l) }); }
    catch (e) { out.warn(`Taiwan lodging register unavailable (${e.message})`); }
  }
  const regCands = (reg?.candidates || []).map((c) => ({ ...c, registry: { ...c.registry } }));
  if (!cands.length && !regCands.length) {
    // the search could not answer and the register had nothing: unavailable (exit 4), never "no such place"
    if (searchErr && isSkip(searchErr)) throw goOn(searchErr);
    out.result({ ok: false, status: 'not_found', query: q, candidates: [], ...(reg ? { registry: [] } : {}) }, [`No results for "${q}"${searchErr ? ` (${searchErr.message})` : ''}. Try a simpler name, add the city ("… Taipei"), or the local-language name.`]);
    return 2;
  }
  // an answer from a fallback source (the first search was down or found nothing) is partial, and says so
  const partialNote = partialCandidatesLine(cands);
  if (partialNote) console.error(partialNote);
  out.result({ ok: true, status: searchErr || partialNote ? 'partial' : 'ok', query: q, near, candidates: cands, ...(partialNote ? { partial: partialNote } : {}), ...(reg ? { registry: regCands, unplaced: reg.unplaced } : {}) }, [
    ...cands.map(fmtCand),
    regCands.length ? `Taiwan lodging register (data.gov.tw 7780 + Taipei 135464; coordinates as filed by the operator):\n${regCands.map((c, i) => '  ' + fmtRegistryCand(c, i)).join('\n')}` : null,
    ...(reg?.unplaced || []).map((u) => `  Taipei register: "${u.name}" (${u.licence_id || 'no licence id'}) at ${u.address} (no coordinates)`),
    regCands.length ? `Add one: add-point <site> --layer hotels --query "${q}" --near <lng,lat> (falls back to the register itself), or --source registry --pick N.` : null,
  ]);
  if (!near) out.warn('no --near given: results are not biased to your area; double-check the country/city.');
}

export async function addPoint(argv) {
  const ctx = {};
  try { return await addPointRun(argv, ctx); } catch (e) {
    // out of time or unavailable (the search / Overpass busy or down): the place is still listed as "Not found yet", so the reply can say so
    if (isSkip(e) && ctx.site && ctx.args?.query) {
      noteMissing(ctx.site, { layer: ctx.layer, id: ctx.args.id, name: ctx.args.name || queryLabel(ctx.args.query), query: ctx.args.query,
        tried: [...(ctx.tried || []), `${e.service || 'search'} (busy: skipped)`] });
      e.kept = `"${ctx.args.name || queryLabel(ctx.args.query)}" listed as "Not found yet" on the map`;
    }
    throw e;
  }
}
async function addPointRun(argv, ctx) {
  const args = parseArgs(argv, { layer: 'string', query: 'string', near: 'string', id: 'string', name: 'string', emoji: 'string',
    note: 'string', props: 'string', pick: 'number', 'allow-far': 'bool', 'allow-mismatch': 'bool', 'max-km': 'number', at: 'string', lang: 'string', kind: 'string', osm: 'string',
    source: 'string', tier: 'string', 'no-fit': 'bool', country: 'string', 'strict-name': 'bool' },
  { positionals: [1, 1], command: 'add-point' });
  if (args.help) return console.log(helps.addPoint);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  Object.assign(ctx, { site, layer, args });
  let extra = {};
  if (args.props) {
    try { extra = JSON.parse(args.props); } catch (e) { throw new UsageError(`--props is not valid JSON (${e.message}). Example: --props '{"price":120,"area":"Zhongshan"}'`); }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new UsageError('--props must be a JSON object');
  }
  if (!args.query && !args.at && !args.osm) throw new UsageError('give --query "<place name or street address>" (or --osm <osm id>, or --at lng,lat --name "…" for coordinates the user provided)');
  if ([args.query, args.at, args.osm].filter(Boolean).length > 1) throw new UsageError('use one of --query, --osm or --at');
  const source = sourceArg(args.source);
  if (args.source && !args.query) throw new UsageError('--source only applies to --query');
  if (args.tier && !TIERS.includes(args.tier)) throw new UsageError('--tier must be option, support or context');

  let chosen, cands = [], skipped = [], warnings = [], reg = null, regUsed = false;
  const tried = [];
  ctx.tried = tried;
  // a place that could not be added is listed on the map as "not found yet" (map.config.json "missing") until it is
  const refuse = (code, lines, json) => {
    noteMissing(site, { layer, id: args.id, name: args.name || queryLabel(args.query || ''), query: args.query, tried });
    if (out.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
    console.error([...lines, `Listed on the map as "not found yet" (map.config.json "missing"); it goes away once this place is added.`].join('\n'));
    return code;
  };
  const maxKm = args['max-km'] ?? 8;
  if (args.at) {
    const coord = parseLngLat(args.at, 'at');
    if (!args.name) throw new UsageError('--at needs --name "Label"');
    chosen = { name: args.name, coord, type: null, kind: args.kind || null, address: '', osm_id: null };
  } else if (args.osm) {
    chosen = await osmObject(args.osm);
    const near = args.near ? parseLngLat(args.near, 'near') : viewCenter(site);
    if (near) chosen.distance_km = Math.round(haversine(near, chosen.coord) / 10) / 100;
    if (near && chosen.distance_km > maxKm && !args['allow-far'])
      throw new UserError(`${args.osm} (${chosen.name}) is ${chosen.distance_km} km from ${args.near ? '--near' : 'view.center'} (> ${maxKm}); check the id, or pass --allow-far`);
  } else {
    const explicitNear = !!args.near;
    const near = args.near ? parseLngLat(args.near, 'near') : viewCenter(site);
    if (!explicitNear) {
      if (near) out.log(`(no --near: biasing with view.center ${near.join(',')})`);
      else out.warn('no --near and no view.center in map.config.json: results are not biased to your area.');
    }
    const bounds = viewBounds(site);
    const tooFar = (c) => {
      if (explicitNear) return c.distance_km > maxKm;
      if (bounds) {
        const [w, s, e, n] = bounds, mx = (e - w) * 0.5, my = (n - s) * 0.5;
        const inView = c.coord[0] >= w - mx && c.coord[0] <= e + mx && c.coord[1] >= s - my && c.coord[1] <= n + my;
        return !inView && !(c.distance_km != null && c.distance_km <= maxKm);
      }
      return false;
    };
    const limitText = explicitNear ? `${maxKm} km from --near` : `the map view (view.bounds + 50%) or ${maxKm} km of view.center`;
    // Taiwan lodging: the official registers know hotels OpenStreetMap lacks (new, renamed, small)
    const registerHere = adapterForArea('lodging-register', site, near, args.query);
    const twLodging = isLodging({ query: args.query, kind: args.kind || extra.kind, layer }) && !!registerHere;
    if (source === 'registry' && !registerHere) throw new UsageError('--source registry: no lodging register covers this area (uw adapter list --at <lng,lat>); pass a --near inside one (from geocode)');
    const useRegistry = source === 'registry' || (source === 'auto' && twLodging);
    const regLookup = async () => {
      if (reg) return reg;
      tried.push('Taiwan lodging registers (data.gov.tw 7780, Taipei 135464)');
      try {
        reg = await registrySearch(args.query, { near, maxKm, inRange: (c) => !tooFar(c), log: (l) => console.error(l) });
      } catch (e) { reg = { candidates: [], unplaced: [], error: e.message }; warnings.push(`Taiwan lodging register unavailable (${e.message})`); }
      return reg;
    };
    let searchErr = null;
    // the search was slow, hung or down minutes ago (any uw command): a confident register match is taken without waiting on it
    if (source === 'auto' && twLodging && args.pick === undefined && geocodeDegraded()) {
      const r = await regLookup();
      if (acceptable(r.candidates[0])) {
        chosen = r.candidates[0]; regUsed = true;
        out.log(`The place search is slow or down right now; using Taiwan's lodging register (data.gov.tw 7780${chosen.registry.register ? ' + Taipei 135464' : ''}) without waiting for it.`);
      }
    }
    if (source !== 'registry' && !regUsed) {
      tried.push(searchLabel());
      try { cands = await geocodeSearch(args.query, { near, limit: 6, lang: args.lang || 'default' }); }
      catch (e) { if (!useRegistry) throw e; searchErr = e; cands = []; }
      if (!cands.length && !useRegistry) {
        return refuse(2, [`no results for "${args.query}". Try the local-language name, add the district/city, or a nearby landmark. Nothing was written.`],
          { ok: false, refused: 'no_results', query: args.query, candidates: [] });
      }
    }
    if (cands.length && !geocodeDegraded()) {
      // English names (lang=en) for the same OSM objects, when they differ (not while the search is slow or down).
      try {
        const en = await geocodeSearch(args.query, { near, limit: 6, lang: 'en', onEmpty: 'stop' });
        for (const c of cands) {
          const m = en.find((e) => e.osm_id && e.osm_id === c.osm_id);
          if (m && m.name && m.name !== c.name) c.name_en = m.name;
          if (m && m.district && m.district !== c.district) c.district_en = m.district;
          if (m && m.city && m.city !== c.city) c.city_en = m.city;
          if (m && m.state && m.state !== c.state) c.state_en = m.state;
          if (m && m.country && m.country !== c.country) c.country_en = m.country;
          if (m && m.address && m.address !== c.address) c.address_en = m.address;
        }
      } catch { /* optional */ }
    }
    if (args.country && cands.length) {
      // the country the caller knows the place is in: hits elsewhere (Tokyo → Papua New Guinea) are not candidates
      const inCountry = cands.filter((c) => countryMatches(c, args.country) !== false);
      if (!inCountry.length && !useRegistry) {
        return refuse(2, [`REFUSED: no result for "${args.query}" is in ${args.country}:`, ...cands.map(fmtCand),
          'Nothing was written. Check the name (the local-language name helps), or the country.'],
        { ok: false, refused: 'country_mismatch', query: args.query, country: args.country, candidates: cands });
      }
      cands = inCountry;
    }
    const qType = queryType(args.query);
    const area = areaWordsOf(cands);
    // --kind city|town|village|place: a place object, never a shop or a station that carries the city's name
    // ("Tokyo Shoes Retailing Center" for Tokyo)
    const placeKind = /^(city|town|village|place)$/i.test(String(args.kind || '')) ? /^place[=:]/ : null;
    const annotate = (list, q) => { for (const c of list) { c.name_match ??= nameMatches(q, [c.name, c.name_en], area); c.type_ok = qType ? qType.ok.test(c.type || '') : placeKind ? placeKind.test(c.type || '') : null; } };
    annotate(cands, args.query);
    // --allow-far: distance never decides (a stop far from the map's first view is still that stop)
    const good = (c) => (args['allow-far'] || !tooFar(c)) && c.name_match !== false && c.type_ok !== false;
    // (also with --pick, so the numbers in a refusal and in --pick always mean the same list)
    if (cands.length && qType && !cands.some(good)) {
      // e.g. "Hualien Station" finds a weather station; search again for the type itself near the same place.
      const q2 = stripType(args.query, qType);
      if (q2) {
        try {
          const more = await geocodeSearch(q2, { near, limit: 4, lang: args.lang || 'default', tags: qType.tags, onEmpty: 'stop' });
          const known = new Set(cands.map((c) => c.osm_id));
          const add = more.filter((c) => !known.has(c.osm_id));
          for (const c of add) { c.name_match = nameMatches(q2, [c.name, c.name_en]) ?? null; if (c.name_match === false) c.name_match = null; c.via = 'type search'; }
          annotate(add, q2);
          cands.push(...add);
        } catch { /* optional */ }
      }
    }
    if (source === 'registry') {
      const r = await regLookup();
      const list = r.candidates;
      if (args.pick !== undefined) {
        if (!Number.isInteger(args.pick) || args.pick < 1 || args.pick > list.length)
          throw new UsageError(`--pick ${args.pick} is out of range; the register has ${list.length} candidate(s):\n${list.map(fmtRegistryCand).join('\n')}`);
        chosen = list[args.pick - 1]; regUsed = true;
      } else if (acceptable(list[0])) { chosen = list[0]; regUsed = true; }
    } else if (cands.length && args.pick !== undefined) {
      if (!Number.isInteger(args.pick) || args.pick < 1 || args.pick > cands.length)
        throw new UsageError(`--pick ${args.pick} is out of range; there are ${cands.length} candidates:\n${cands.map(fmtCand).join('\n')}`);
      chosen = cands[args.pick - 1];
    } else if (cands.length) {
      // First candidate in range whose name (and type, when the query names one) matches; else first in range.
      let idx = cands.findIndex(good);
      if (idx < 0) idx = cands.findIndex((c) => !tooFar(c));
      if (idx > 0) skipped = cands.slice(0, idx).filter((c) => tooFar(c));
      chosen = idx >= 0 ? cands[idx] : cands[0];
      // Same place mapped twice (e.g. landuse/building outline + the tourism=hotel object): prefer the POI,
      // or the candidate whose OSM value equals --kind. Never "upgrade" to an entrance, platform or stop
      // (大安森林公園站 matched the station building, then moved to exit 1).
      const poiKey = /^(tourism|amenity|shop|leisure|railway|public_transport|historic|aeroway|natural|office|craft|healthcare|club|sport)=/;
      const better = cands.find((c) => c !== chosen && !tooFar(c) && c.name_match !== false && c.type_ok !== false && haversine(c.coord, chosen.coord) < 300 &&
        !PART_TYPE.test(c.type || '') &&
        (args.kind ? c.kind === args.kind && chosen.kind !== args.kind : poiKey.test(c.type) && !poiKey.test(chosen.type || '') && !(exactName(args.query, chosen) && !exactName(args.query, c))));
      if (better) chosen = better;
      // the chosen one is a part (entrance, platform, stop) but the station / main object is listed too: take that
      if (PART_TYPE.test(chosen.type || '')) {
        const main = cands.find((c) => c !== chosen && !tooFar(c) && c.name_match !== false && !PART_TYPE.test(c.type || '') && haversine(c.coord, chosen.coord) < 400);
        if (main) chosen = main;
      }
    }
    // the search's match missing, far, or unsure (no name match, wrong type, found only by a type search) → the registers
    const searchWeak = !chosen || tooFar(chosen) || chosen.name_match === false || chosen.type_ok === false || chosen.via === 'type search';
    if (source === 'auto' && useRegistry && searchWeak && args.pick === undefined) {
      const r = await regLookup();
      if (acceptable(r.candidates[0])) {
        chosen = r.candidates[0]; regUsed = true;
        out.log(`The place search had no good match${searchErr ? ` (${searchErr.message})` : ''}; using Taiwan's lodging register (data.gov.tw 7780${chosen.registry.register ? ' + Taipei 135464' : ''}).`);
      }
    }
    const regLines = () => {
      if (!reg) return [];
      const L = [];
      if (reg.candidates.length) L.push('Taiwan lodging register candidates (re-run with --source registry --pick N to take one):', ...reg.candidates.map((c, i) => '  ' + fmtRegistryCand(c, i)));
      else if (!reg.error) L.push(`Taiwan lodging registers: no listing named like "${queryLabel(args.query)}" within ${limitText}.`);
      for (const u of reg.unplaced || []) L.push(`  The Taipei register lists "${u.name}" (${u.licence_id || 'no licence id'}) at ${u.address}, without coordinates: add it by its street address (--query "<road + number>" --name "…").`);
      return L;
    };
    if (source === 'registry' && !regUsed) {
      return refuse(2, [`REFUSED: no confident register match for "${args.query}" (${reg?.error || 'none high or medium'}):`, ...regLines(),
        'Nothing was written. Use --pick N for a listed candidate, or add it by street address (--source osm).'],
      { ok: false, refused: 'registry_no_match', query: args.query, registry: reg?.candidates || [], unplaced: reg?.unplaced || [] });
    }
    // the search could not answer and the register had nothing: unavailable (exit 4, "Not found yet"), never a wrong name
    if (!chosen && searchErr && isSkip(searchErr)) throw searchErr;
    if (!chosen) {
      return refuse(2, [`REFUSED: no match for "${args.query}"${searchErr ? ` (${searchErr.message})` : ''}:`, ...regLines(),
        'Nothing was written. Ask the user for the street address, then --query "<street address>" --name "<name>".'],
      { ok: false, refused: 'no_results', query: args.query, candidates: [], registry: reg?.candidates || [] });
    }
    if (!regUsed) {
      if (tooFar(chosen) && !args['allow-far']) {
        const alt = near ? await altNameSearch(args.query, near).catch(() => []) : [];
        if (near) tried.push('OpenStreetMap old/alternative names (Overpass)');
        return refuse(2, [`REFUSED: the best match for "${args.query}" is outside ${limitText}:`, ...cands.map(fmtCand),
          ...altLines(alt, args, layer), ...regLines(),
          'Nothing was written. This usually means a wrong match: refine --query (add district/city or local name),',
          `check --near (lng,lat order), use --pick N for another candidate, or pass --allow-far if it really is that far.`],
        { ok: false, refused: 'too_far', query: args.query, candidates: cands, registry: reg?.candidates || [] });
      }
      // --strict-name: only a candidate whose own name carries the query's name (never a type search or an unsure one):
      // a researched place with a sourced reason must not land on another place of the same kind
      const unsure = args['strict-name'] && args.pick === undefined && (chosen.name_match !== true || chosen.via === 'type search');
      const mismatch = chosen.name_match === false || unsure ? 'name' : chosen.type_ok === false ? 'type' : null;
      if (mismatch && args.pick === undefined && !args['allow-mismatch']) {
        const what = mismatch === 'name' ? `no candidate's name looks like "${args.query}"` : `no candidate nearby is the kind of place "${args.query}" names`;
        // the search does not index old / alternative names; OSM often keeps them (disused:name=亞士都飯店 on the renamed hotel)
        const alt = near && mismatch === 'name' ? await altNameSearch(args.query, near).catch(() => []) : [];
        if (near && mismatch === 'name') tried.push('OpenStreetMap old/alternative names (Overpass)');
        return refuse(2, [`REFUSED: ${what} (best in range: "${chosen.name}${chosen.name_en ? ' / ' + chosen.name_en : ''}" [${chosen.type}]):`,
          ...cands.map(fmtCand), ...altLines(alt, args, layer), ...regLines(),
          'Nothing was written. The place may be missing from OpenStreetMap or named differently. Try the local-language or official name,',
          'or geocode its street address (from the user or the official listing): --query "<street address>" --name "<name>" --props \'{"source":"…"}\'.',
          'If one candidate IS the place, re-run with --pick N. (--allow-mismatch accepts the best one as is.)'],
        { ok: false, refused: mismatch + '_mismatch', query: args.query, candidates: cands, registry: reg?.candidates || [] });
      }
      // a street address that resolved to a whole district or city is not the place (the search falls back to the area)
      const looksAddress = /\d+\s*(號|号|番地?)|\bno\.?\s*\d+|^\s*\d+[A-Za-z]?\s+\S+|\S+\s+\d+[A-Za-z]?\s*(,|$)/i.test(args.query);
      const areaLevel = /^(place=(city|town|village|suburb|quarter|neighbourhood|county|state|province|borough|district|city_block)|boundary=)/.test(chosen.type || '');
      if (looksAddress && areaLevel && args.pick === undefined && !args['allow-mismatch']) {
        return refuse(2, [`REFUSED: the address "${args.query}" resolved to an area (${chosen.name} [${chosen.type}]), not a building:`, ...cands.map(fmtCand),
          'Nothing was written. Try the street part alone in local form (e.g. "延平北路三段 4號" or "Damrak 1"), without district',
          'and city (keep --near), check it with `geocode` first, or --pick N if a listed candidate IS the address.'],
        { ok: false, refused: 'address_area', query: args.query, candidates: cands });
      }
      if (PART_TYPE.test(chosen.type || '')) warnings.push(`"${chosen.name}" is ${chosen.type} (an entrance, platform or stop), not the place itself: check it, or --pick another`);
      else if (TRANSPORT_TYPE.test(chosen.type || '') && !(qType && /station/.test(qType.tags[0] || '')) && !/station|stop|站|駅|terminal|bus/i.test(args.query))
        warnings.push(`"${chosen.name}" is a transport object (${chosen.type}) but the query names something else: check it is the right one`);
      if (chosen.via === 'type search') warnings.push(`"${chosen.name}" was found by a ${qType.tags[0].replace(':', '=')} search near --near, not by name: check it is the right one`);
      if (tooFar(chosen)) warnings.push(`chosen match is outside ${limitText} (allowed by --allow-far)`);
      if (skipped.length) warnings.push(`skipped ${skipped.length} closer-ranked match(es) outside ${limitText}: ${skipped.map((c) => `${c.name} (${c.distance_km ?? '?'} km)`).join(', ')}`);
    } else {
      const r = chosen.registry;
      const m = r.matched.map((x) => `${x.on} "${x.text}"`).join(' + ');
      const regName = `${chosen.name}${chosen.name_local ? ` / ${chosen.name_local}` : ''}`;
      if (chosen.confidence !== 'high') warnings.push(`register match is ${chosen.confidence} (matched on ${m}). Tell the user: "${queryLabel(args.query)}" is shown as the registered listing ${regName} (${r.licence_id || 'no licence id'}); never ask them to confirm it`);
      else if (!r.matched.some((x) => x.on === 'name' && x.text && queryLabel(args.query).toLowerCase().replace(/\s+/g, '') === String(x.text).toLowerCase().replace(/\s+/g, '')))
        warnings.push(`registered under another name: ${regName} (matched on ${m}). Tell the user it is listed as ${chosen.name}`);
      if (r.coord_shared > 2) warnings.push(`${r.coord_shared} register listings share this exact coordinate (a building, or a rough location): check the pin`);
      if (!r.open) warnings.push(`the register marks this listing as not operating (ServiceStatus ${r.open})`);
    }
  }

  // Build the feature
  const label = args.name || (regUsed ? queryLabel(args.query) : null);
  const name = label || chosen.name;
  let id = args.id ? String(args.id) : regUsed ? slugFor(name, chosen) : slugify(chosen.name_en || name) || (chosen.osm_id || `pt-${Date.now().toString(36)}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new UsageError(`--id "${id}" should be a slug (letters, digits, - _ .), e.g. via-loft`);
  let props = { id, name };
  let kind;
  if (regUsed) {
    props = { id, ...registryProps(chosen, { label: name }) };
    kind = args.kind || extra?.kind || chosen.kind;
    props.kind = kind;
    props.emoji = args.emoji || extra?.emoji || emojiFor(kind);
    if (args.note) props.note = args.note;
  } else {
    // --name "Taipei" must also be the English label (the engine shows name_en in English mode)
    if (args.name && /[A-Za-z]/.test(args.name) && !/[぀-ヿ㐀-鿿가-힯]/.test(args.name)) {
      props.name_en = args.name;
      if (chosen.name_en && chosen.name_en !== args.name) props.osm_name_en = chosen.name_en;
    } else if (chosen.name_en && chosen.name_en !== name) props.name_en = chosen.name_en;
    // an address match is a house number, not what the place is: take the kind from --kind / --props, never "house"
    const addrHit = /^(house|building|street|address)$/.test(String(chosen.kind || chosen.type || ''));
    kind = args.kind || extra?.kind || (addrHit ? null : chosen.kind);
    if (kind) props.kind = kind;
    props.emoji = args.emoji || extra?.emoji || (kind ? emojiFor(kind) : emojiFor(layer.replace(/s$/, '')));
    if (addrHit && !args.kind && !extra?.kind) warnings.push(`matched an address: pass --kind (e.g. --kind hotel) so the card says what ${name} is`);
    if (chosen.address) props.address = chosen.address;
    if (chosen.address_en) props.address_en = chosen.address_en;
    if ((chosen.district_en || chosen.district) && !extra.area) props.area = chosen.district_en || chosen.district;
    if (args.note) props.note = args.note;
    if (chosen.osm_id) props.osm_id = chosen.osm_id;
    props.source = args.at ? 'user-provided coordinates' : args.osm ? 'OpenStreetMap' : chosen.source || 'OpenStreetMap';
    // found by a fallback source: the point says so (and what it lacks) until a full answer replaces it
    Object.assign(props, partialProps(chosen));
  }
  Object.assign(props, extra);
  props.id = id; // --props cannot change the id silently
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: chosen.coord.map(round6) }, properties: props };

  // the register's licence credit is loaded before the write lock is taken (no waiting inside it)
  const { ATTRIBUTION } = regUsed ? await import('../adapters/tw-hotels.mjs') : {};
  // read, change and write the layer and map.config.json under the site's write lock: another command (another stop
  // of handoff --apply) may write them at the same time
  const { rel, replaced, cfgChanges, def, cfg } = withSiteLock(site, () => {
    const p = layerPath(site, layer);
    let fc = { type: 'FeatureCollection', features: [] };
    if (exists(p)) {
      try { fc = readJSON(p); } catch (e) { throw new UserError(`${p} is not valid JSON (${e.message}); fix or delete it first`); }
      if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new UserError(`${p} is not a FeatureCollection`);
    }
    const i = fc.features.findIndex((f) => f?.properties?.id === id);
    const replaced = i >= 0;
    if (replaced) {
      // Same place again: keep metrics/notes added later (enrich, hand edits); moved: drop them (they are stale).
      const prev = fc.features[i];
      const prevC = prev?.geometry?.type === 'Point' ? prev.geometry.coordinates : null;
      if (prevC && haversine(prevC, feature.geometry.coordinates) < 25) feature.properties = { ...prev.properties, ...feature.properties };
      else if (Object.keys(prev?.properties || {}).length > Object.keys(feature.properties).length) warnings.push(`${id} moved; its old metrics were dropped. Re-run enrich for ${layer}.`);
      fc.features[i] = feature;
    } else fc.features.push(feature);
    // Same OSM object, or the same spot, already present under another id? (a renamed hotel listed twice, say)
    const dupe = chosen.osm_id && fc.features.find((f) => f !== feature && f?.properties?.osm_id === chosen.osm_id);
    const dupeReg = props.tw_hotel_id && fc.features.find((f) => f !== feature && f?.properties?.tw_hotel_id === props.tw_hotel_id);
    if (dupe) warnings.push(`the same OSM object is already in this layer as "${dupe.properties.id}"`);
    else if (dupeReg) warnings.push(`the same register listing is already in this layer as "${dupeReg.properties.id}"`);
    else {
      const close = fc.features.find((f) => f !== feature && f?.geometry?.type === 'Point' && haversine(f.geometry.coordinates, feature.geometry.coordinates) < 30);
      if (close) warnings.push(`"${close.properties.id}" (${close.properties.name}) is within 30 m: same building? A place can be listed twice under an old and a new name.`);
    }
    fc.uw = { ...(fc.uw || {}), cmd: fc.uw?.cmd || 'add-point', updated_at: new Date().toISOString() };
    writeGeoJSON(p, fc);
    const rel = p.slice(site.dir.length + 1);

    // map.config.json: register the layer (so the point shows at once), drop its "not found yet" entry, add the
    // register's licence credit, and keep the options on screen
    const cfgChanges = [];
    const cfg = readJSON(site.cfgPath);
    site.config = cfg;
    let def = configLayer(site, layer);
    if (!def) {
      const tier = args.tier || (OPTION_LAYER.test(layer) ? 'option' : 'support');
      def = { id: layer, title: titleCase(layer), type: 'points', data: layerRelPath(site, layer), tier, style: { emoji: props.emoji }, list: true };
      if (tier !== 'option') { const col = colorFor(kind || layer); if (col) def.style.color = col; }
      cfg.layers = [...(Array.isArray(cfg.layers) ? cfg.layers : []), def];
      cfgChanges.push(`registered layer "${layer}" (tier ${tier})`);
    } else if (args.tier && def.tier !== args.tier) { def.tier = args.tier; cfgChanges.push(`set ${layer} tier to ${args.tier}`); }
    const missBefore = (cfg.missing || []).length;
    clearMissing(cfg, { layer, id, name, query: args.query });
    if ((cfg.missing || []).length < missBefore) cfgChanges.push('removed its "not found yet" entry');
    if (!cfg.missing?.length) delete cfg.missing;
    if (regUsed) {
      const list = Array.isArray(cfg.attribution) ? cfg.attribution : [];
      if (!list.includes(ATTRIBUTION)) { cfg.attribution = [...list, ATTRIBUTION]; cfgChanges.push('added the Taiwan open-data credit'); }
    }
    writeJSON(site.cfgPath, cfg, { pretty: true });
    return { rel, replaced, cfgChanges, def, cfg };
  });
  let view = null;
  const isOption = def.tier === 'option' || cfg.question?.options?.layer === layer;
  if (isOption && !args['no-fit']) {
    try { view = (await fitView(site, { out })).view; cfgChanges.push(`view framed on the options (zoom ${view.zoom})`); }
    catch (e) { warnings.push(`could not fit the view (${e.message}); run: uw fit ${args._[0]}`); }
  }

  for (const w of warnings) out.warn(w);
  const partialNote = !regUsed && chosen.data_status === 'partial' ? partialLine(`${layer}:${id} ${name}`, chosen.data_reason || 'found by a fallback source', `check its place on the map; re-run this add-point later for the full answer`) : null;
  if (partialNote) console.error(partialNote);
  const altList = regUsed ? cands : cands.filter((c) => c !== chosen);
  out.result({ ok: true, ...(partialNote ? { status: 'partial', partial: partialNote } : { status: 'ok' }), layer, file: rel, id, replaced, source: regUsed ? 'registry' : args.at ? 'user' : args.osm ? 'osm' : chosen.provider || 'search',
    chosen: { ...chosen, name, id }, alternatives: altList, registry_alternatives: reg ? reg.candidates.filter((c) => c !== chosen) : [],
    warnings, config: cfgChanges, view }, [
    `${replaced ? 'Replaced' : 'Added'} ${layer}:${id} — ${props.emoji} ${name}${props.name_en && props.name_en !== name ? ` (${props.name_en})` : ''}` +
      (regUsed ? ` [registry: ${chosen.name}${chosen.name_local ? ' / ' + chosen.name_local : ''} · licence ${chosen.registry.licence_id || '—'} · match ${chosen.confidence} on ${chosen.by.join('+')}]`
        : ` [${chosen.type || 'user point'}]`) +
      `${(regUsed ? props.address : chosen.address) ? ' — ' + (regUsed ? props.address : chosen.address) : ''} @ ${chosen.coord.join(',')}${chosen.distance_km != null ? ` (${chosen.distance_km} km from near)` : ''}`,
    regUsed ? `  source: ${props.prov.source}${props.prov.also ? ' + ' + props.prov.also : ''} (open data, as of ${props.prov.as_of || '?'}; coordinates as filed by the operator)` : null,
    regUsed && cands.length ? 'Place search candidates, not chosen (--source osm --pick N takes one):\n' + cands.map((c, k) => '    ' + fmtCand(c, k)).join('\n')
      : !regUsed && cands.length > 1 ? 'Alternatives (use --pick N to choose another):\n' + cands.map((c, k) => (c === chosen ? '  * ' : '    ') + fmtCand(c, k)).join('\n') : null,
    reg && reg.candidates.filter((c) => c !== chosen).length ? 'Register alternatives (--source registry --pick N):\n' + reg.candidates.map((c, k) => (c === chosen ? '  * ' : '    ') + fmtRegistryCand(c, k)).join('\n') : null,
    cfgChanges.length ? `map.config.json: ${cfgChanges.join('; ')}.` : null,
  ]);
}

const TIERS = ['option', 'support', 'context'];
// layers named like the user's shortlist become the option tier (lettered pins once a question exists)
const OPTION_LAYER = /^(hotels?|hostels?|stays?|lodging|accommodations?|options?|choices?|candidates?|shortlist|picks|apartments?|homes?|flats?|venues?|schools?|offices?|neighbou?rhoods?)$/i;
// support colours stay ≥ 20 ΔE from every option letter colour in both themes (validate warns below that)
const COLORS = [[/cafe|coffee/, '#78350f'], [/restaurant|food|bakery|bar|pub/, '#d97706'], [/park|garden|green/, '#16a34a'],
  [/station|mrt|metro|train|stop/, '#86198f'], [/museum|gallery|temple|sight|attraction/, '#a21caf'], [/hotel|hostel|guest|stay|lodging/, '#0e7490'],
  [/shop|market|mall|store/, '#c026d3'], [/gym|sport|fitness/, '#0891b2']];
function colorFor(k) { const s = String(k || '').toLowerCase(); return (COLORS.find(([re]) => re.test(s)) || [null, '#1e293b'])[1]; }

// map.config.json "missing": places the user asked for that are not on the map yet (shown as "Not found yet")
const missKey = (s) => String(s || '').toLowerCase().replace(/[\s,，、]+/g, ' ').trim();
export function noteMissing(site, { layer, id, name, query, tried = [] }) {
  if (!site?.config || !name) return;
  try {
    withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    const list = Array.isArray(cfg.missing) ? cfg.missing : [];
    const key = missKey(name);
    const entry = { name, layer, ...(id ? { id } : {}), ...(query && query !== name ? { query } : {}),
      tried: [...new Set(tried)].length ? [...new Set(tried)] : [searchLabel()], at: new Date().toISOString().slice(0, 10) };
    const k = list.findIndex((m) => m && ((id && m.id === id && m.layer === layer) || missKey(m.name) === key));
    if (k >= 0) list[k] = { ...list[k], ...entry, tried: [...new Set([...(list[k].tried || []), ...entry.tried])] }; else list.push(entry);
    cfg.missing = list;
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    });
  } catch { /* the refusal itself matters more */ }
}
/** Take a place off the "Not found yet" list (an alternative the plan does not need, e.g. a researched hotel at a
 *  stop that already has its base). */
export function forgetMissing(site, entry) {
  try {
    return withSiteLock(site, () => {
      const cfg = readJSON(site.cfgPath);
      const before = (cfg.missing || []).length;
      clearMissing(cfg, entry);
      if ((cfg.missing || []).length === before) return false;
      if (!cfg.missing.length) delete cfg.missing;
      writeJSON(site.cfgPath, cfg, { pretty: true });
      site.config = cfg;
      return true;
    });
  } catch { return false; }
}
function clearMissing(cfg, { layer, id, name, query }) {
  if (!Array.isArray(cfg.missing)) return;
  const keys = new Set([missKey(name), missKey(queryLabel(query || '')), missKey(query)].filter(Boolean));
  cfg.missing = cfg.missing.filter((m) => !(m && ((m.id && m.id === id && (m.layer || layer) === layer) || keys.has(missKey(m.name)) || (m.query && keys.has(missKey(m.query))))));
}

// Parts of a place (entrances, platforms, stops): never the thing a person asked for by name.
const PART_TYPE = /^(railway=(subway_entrance|entrance|train_station_entrance|platform|stop|stop_position|halt_position)|public_transport=(platform|stop_position|stop_area|entrance)|highway=(bus_stop|platform)|entrance=)/;
const TRANSPORT_TYPE = /^(highway=bus_stop|amenity=(bus_station|taxi|ferry_terminal)|public_transport=|railway=(halt|stop|tram_stop))/;
function exactName(q, c) {
  const n = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
  return [c.name, c.name_en].some((x) => x && n(x) === n(q));
}

// One OSM object by id (osm-n123 / osm-w456 / osm-r789 or node/123 …) → candidate with its centre.
async function osmObject(ref) {
  const m = String(ref).trim().match(/^(?:osm-)?([nwr]|node|way|relation)[/:]?(\d+)$/i);
  if (!m) throw new UsageError(`--osm "${ref}" should look like osm-w940449133 (n = node, w = way, r = relation)`);
  const type = { n: 'node', w: 'way', r: 'relation' }[m[1][0].toLowerCase()];
  const data = await overpass(`[out:json][timeout:25];\n${type}(${m[2]});\nout center tags;`, { timeoutS: 25 });
  const el = (data.elements || [])[0];
  if (!el) throw new UserError(`no OpenStreetMap ${type} ${m[2]} (deleted, or a typo in the id)`);
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  const t = el.tags || {};
  const key = ['tourism', 'amenity', 'shop', 'leisure', 'railway', 'building', 'historic', 'natural', 'office'].find((k) => t[k]);
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  return { name: t.name || t['name:en'] || t['disused:name'] || t['old_name'] || `${type} ${m[2]}`, name_en: t['name:en'] || null,
    type: key ? `${key}=${t[key]}` : '', kind: key ? t[key] : null, address: t['addr:full'] || [street, t['addr:district'] || t['addr:suburb'], t['addr:city']].filter(Boolean).join(', '),
    coord: [round6(lon), round6(lat)], osm_id: `osm-${type[0]}${m[2]}`, district: t['addr:district'] || t['addr:suburb'] || null };
}

// Old / alternative / English names within 3 km (one Overpass query): what the search cannot find.
async function altNameSearch(q, near) {
  const tokens = (q.match(/[\p{L}\p{N}]{2,}/gu) || []).filter((t) => !GENERIC.has(t.toLowerCase()) && !CJK_GENERIC.test(t));
  CJK_GENERIC.lastIndex = 0;
  if (!tokens.length) return [];
  const re = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\"]/g, '')).join('.*');
  const keys = 'name|name:en|alt_name|old_name|official_name|disused:name|disused:name:en|old_name:en|was:name';
  // one statement per key (a key regex scans every key and times out on busy servers)
  // (the area is collected once into a set, then filtered per key)
  const stmts = keys.split('|').map((k) => `  nwr.a["${k}"~"${re}",i];`).join('\n');
  const data = await overpass(`[out:json][timeout:40];\nnwr(around:2000,${near[1]},${near[0]})->.a;\n(\n${stmts}\n);\nout center tags 8;`, { timeoutS: 40, quick: true });
  return (data.elements || []).map((el) => {
    const t = el.tags || {};
    const matchedKey = keys.split('|').find((k) => t[k] && new RegExp(re, 'i').test(t[k]));
    const key = ['tourism', 'amenity', 'shop', 'leisure', 'building', 'disused:tourism', 'railway', 'highway'].find((k) => t[k]);
    const c = [el.lon ?? el.center?.lon, el.lat ?? el.center?.lat];
    return { osm_id: `osm-${el.type[0]}${el.id}`, name: t.name || t[matchedKey] || '?', type: key ? `${key}=${t[key]}` : '', matched: `${matchedKey}=${t[matchedKey]}`,
      address: t['addr:full'] || [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '), distance_km: c[0] != null ? Math.round(haversine(near, c) / 10) / 100 : null };
  }).filter((a) => !/^highway=(bus_stop)/.test(a.type));
}
function altLines(alt, args, layer) {
  if (!alt.length) return [];
  return ['OpenStreetMap has these objects nearby with that name as an old, alternative or English name (renamed or rebranded?):',
    ...alt.map((a) => `  ${a.osm_id}: ${a.name} [${a.type}] (${a.matched}) ${a.address ? '— ' + a.address : ''} ${a.distance_km != null ? `(${a.distance_km} km away)` : ''}`),
    `  If one is the place, add it exactly: add-point ${args._[0]} --layer ${layer} --osm <id> --name "…" (and tell the user about the new name).`];
}
