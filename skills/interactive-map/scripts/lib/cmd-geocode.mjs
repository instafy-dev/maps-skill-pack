// `geocode` and `add-point`: the "geocode" lookup chain (lookup-providers.json: OpenStreetMap search, then
// Wikipedia's article coordinates, then an OpenStreetMap name search, each asked only while the ones before could not
// answer); add-point appends/replaces a point in a layer file.
import { parseArgs, makeOut, parseLngLat, haversine, round6, slugify, readJSON, writeJSON, writeGeoJSON, exists, bboxAround, propsArg, UsageError, UserError } from './util.mjs';
import { fetchJSON, overpass, isSkip, withCap, ask, lookupState, cacheFor, partialLine } from './net.mjs';
import { openSite, checkLayerId, layerPath, layerRelPath, configLayer, titleCase, viewCenter, viewBounds, withSiteLock, pinOf, samePlace, TRANSIT_KIND, loadLayer } from './site.mjs';
import { emojiFor } from './kinds.mjs';
import { fitView } from './cmd-site.mjs';
import { isLodging, LODGING_RE, registrySearch, acceptable, fmtRegistryCand, registryProps, queryLabel, slugFor } from './registry-geo.mjs';
import { adapterFor, adapterNamedIn, adapterForArea } from '../adapters/lib/areas.mjs';
import { unnamedSource, unnamedSourceLine, lateSourceLine, sourceStamp, sourceNotRead, sourceNotReadRefusal, readSource, readSourceLine, LISTING_LAYER } from './cmd-cite.mjs';
import { withDayItems, sourceNotOwn } from './cmd-set.mjs';
import { handoffStep } from './running.mjs';
import { missKey, clearMissing, missedPlace, missingPinned, pinOfFeature, areaWords, sameMissing } from './missing.mjs';
import { expectOf } from './expect.mjs';
import { cityStopTwin, isCityStop } from './stops.mjs';
import { GENERIC, CJK_GENERIC, holdsName } from './names.mjs';
import { askedOf, askedEntry, askedArea, pinNames, namedThisTurn } from './asked.mjs';

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
          [--props '{"price":120}' | --props-file <file|->] [--kind hotel] [--pick N] [--allow-far] [--allow-mismatch] [--max-km 8] [--lang en]
          [--source auto|osm|registry] [--tier option|support|context] [--no-fit] [--country <name|code>] [--strict-name] [--replace] [--json]
add-point <dir> --layer <id> --osm osm-w940449133 [--id slug] [--name …]   (an exact OpenStreetMap object, e.g. one a refusal suggested)
add-point <dir> --layer <id> --at lng,lat --name "Label" [...]     (only for coordinates the user gave you)
  Text with an apostrophe or quotes ("Alfama's") breaks single-quoted --props: pass the object on stdin instead,
    uw add-point <dir> … --props-file - <<'JSON'
    {"why":"Alfama's lanes"}
    JSON
  Not in OpenStreetMap under its name (new, renamed, small)? Geocode its street address instead:
    --query "<street address, district, city>" --name "<real name>" --props-file - <<'JSON'
    {"source":"<where the address came from>"}
    JSON
  --name in Latin script also becomes name_en (the label English maps show); OSM's English name is kept as osm_name_en.
  Geocodes with the place search and appends (or replaces, same id) a point in data/<layer>.geojson. Prints the chosen match and
  the alternatives: check them. --pick N chooses candidate N (1-based) instead.
  One place, one pin: a place already in the layer under another id (the same OpenStreetMap object or register
  listing, or another object of it: the same name within 150 m) is refused (exit 2 "already pinned", naming that pin;
  nothing added, and its "not found yet" entry goes): it is on the map, so a day that needs another place takes a
  different place, never another --pick of it. --replace replaces that pin instead, which keeps its id, so the days and
  notes that name it still do. Under a pin's own id it replaces that pin. A replaced place's items in the plan's days
  link its new source_url, as \`uw set\` does. A station is never the place it is named
  after unless the query (or --kind) asks for transit: a square or place within 600 m of it that has that name (its own,
  or another OpenStreetMap name: "Rossio" is "Praça Dom Pedro IV") is taken, shown as "Rossio" with its own name under
  it; none, or none that could be checked, keeps the station (said). A match farther than --max-km (default 8)
  from --near is refused (exit 2) unless --allow-far. Without --near the config's view.center is used as bias and the
  match must fall inside view.bounds (+50%) or --max-km of view.center. If no candidate's name resembles the query it is refused too (exit 2):
  check the list, then --pick N or --allow-mismatch. Query words that only name the area (the city, region or country
  the candidates are in) do not count as a name match. A place looked up by its name (not by a street address, nor for
  a city or a stop, nor with a --name the query is not) matches only a candidate one of whose own names, in any
  language it carries, holds every word of the query's name that tells it apart (not a generic word, a title such as
  "Saint" or "Royal", a word of where the candidates are, or a word of the candidate's kind), and whose kind fits:
  "Main Square" for "Main Market Square", never "The Editory Boulevard Hotel" for "The Editory House Ribeira"; when
  none in range does by the names the search gave, the other names OpenStreetMap keeps for those that share a word of
  it are looked up once. --strict-name asks for that on any lookup, and also refuses a candidate found only by a type
  search or with nothing to compare by (use it for a researched place: a wrong hotel with the right reason is worse
  than "not found"). A street is never a venue, a sight or a place to stay: one that only carries a word of the query
  is refused ("found a street named …"), unless the query or --kind asks for a street or names that very street.
  On a sight's layer (sights, daytrips, attractions, landmarks), a hotel, a restaurant or café, or a shop named after
  the place (a hotel called after a bazaar, a restaurant that takes a quay's name) is not that place unless its own
  name adds no word to the query's ("<Name>" for "The <Name>"), a shop's adds only its branch ("<Name> <street>"), or
  the lookup asks for its kind (--kind or the query says so: a place to stay, food or drink, a shop): another
  candidate is taken, else it is refused, saying what it found (exit 2, "named_after": "found a hotel named …, not the
  sight …"). Nor is a board or a sign that only carries the place's name (an information board by it, a guidepost
  to it, an advertising board): refused the same way ("found an information board named …, not the sight …"), also
  when what else the search lists is itself named after the place (a business, an office or a stop with the name
  among other words) or only serves it (a stop of that very name), unless the query or --kind asks for a board; a
  sight listed beside it is taken (a building of its name, a museum whose longer name carries it).
  Other layers (a listing's venues, a list of bars) take the business the query names. An item of a listing (a layer
  named events, whats-on, gigs, concerts, festivals or exhibitions) is pinned at the venue its listing names, under its
  own name: --query "<venue>, <city>" --name "<item>" --note "<its date>". With no --name it is refused (exit 2), and
  one looked up by its own name (the query holds the --name) is refused before any lookup and listed "Not found yet"
  under its name ("item_by_its_name").
  --props '{"asked":true}' marks a place the person's message named; once the map keeps the places the person named
  (uw new --asked), the mark goes only on one of them (dropped from another, and said); in a later turn a place the
  person names, marked so, joins the list.
  A place has one "not found yet" entry: one looked up again under another id or wording (with its city after its
  name: "<name> <city>") is kept on its first entry ("also"), and a pin of it under either takes it off. An id that
  is pinned has none: a lookup that finds nothing under a pinned id lists nothing (it says the id is on the map),
  unless it ran with --replace on a pin that was there before it (a wrong match it was to replace): the place is then
  listed by its name, and that pin stays as it was (named).
  One stop per city: on a trip's stops layer the city pinned beside its own station (uw station), or pinned again
  under another id, is refused, naming the stop that is there (exit 2, "already_a_stop"; --replace replaces that stop
  and keeps its id). On a trip of
  two stops or more, a place named with one stop's name is never another stop's place of that name; nor is a stop's
  own place, looked up with no city, one of that name in another town named after a comma (a day trip's).
  A source_url (in --props) that \`uw cite\` did not read in the last hours is read first, before any lookup, as uw cite
  reads a page (robots.txt, link-only sites, bot checks; kept for uw validate). One that cannot be read (HTTP 404,
  refused, no answer in time) is refused (exit 2, with why; nothing added): give the place its own page instead. So is
  an address that is not a page (an image, a PDF), and, once the place is found, a page that does not name it or a
  page another place already cites, where uw validate fails it: a trip's places to see, an area to stay in that says
  why (exit 2, "cite its own page"; nothing added). Elsewhere, or with under about 3 minutes left on the turn's clock,
  it is said and the place added. A listing's items (a layer named events, whats-on, gigs, concerts, festivals or
  exhibitions) share the listing they were read from, each one's source: never refused for a page they share.
  A trip's days that uw plan wrote as a draft in this turn (it refused days short of places) are planned again with
  the place pinned, so the Plan tab has it at once ("Days planned again with it …", each short day named; JSON
  planned_again); they stay a draft, which the plan command the refusal named replaces.
  --country: only candidates in that country (an ISO code like JP, or its name).
  Taiwan lodging (a hotel/hostel/旅館/飯店/民宿 query, --kind hotel, or a layer like "hotels", in Taiwan by --near or the
  view): when the search's match is missing, far or unsure, Taiwan's lodging registers are searched by name (registered name,
  Taipei register name, website, listing name): data.gov.tw 7780 coordinates + address + licence id, with "prov"
  (source, lane open, match confidence). High/medium matches are taken; low ones are listed (--source registry --pick N).
  --source osm never asks the registers; --source registry asks only them. Exit 4 = the search was unavailable (the
  place is listed as "Not found yet"; not a wrong name: do not retry with another query this turn).
  map.config.json: a new layer is registered (points; tier option for a layer named like hotels/options/stays, else
  support; --tier sets it), an option layer keeps the view framed on its points (uw fit; --no-fit skips), and a place
  that could not be added is listed under "missing" (shown as "Not found yet" on the map) until it is pinned under the id
  or name it was looked up by (by its OpenStreetMap object: --osm <its osm id> --name "<that name>"), by the same query,
  or, for a square, a park or a quarter it found under another name ("Main Square" for "Main Market Square"; not a
  lake or a hall inside it), as that place: its object, or a pin of its name inside it. A place a pin already is is not
  listed (the pin a run under its own id was to replace counts only by its own names and object).`,
};

/** The last line of a researched sight's --strict-name refusal: the trip guide's rule (reference/itinerary.md Phase B
 *  step 1). A place to stay (--kind hotel, a stays layer) is not a sight: it never gets it. */
export const STRICT_NEXT = 'Retried once? List it as unverified and add the next sight from the city page.';

// Does a candidate's name plausibly match the query? Generic words (hotel, taipei, 飯店 …) do not count (names.mjs
// GENERIC; city and country words are taken from where the candidates are: areaWordsOf, any country).
// Place-type words in a query ("… Station", "… Hotel"): the match must be that type of object. Order matters (first wins).
const TYPE_WORDS = [
  { word: /\b(hotel|inn|hostel|motel|resort|guest ?house|ryokan)\b|飯店|酒店|旅館|商旅|民宿|旅店/i, ok: /^(tourism=(hotel|hostel|guest_house|motel|apartment|chalet|resort)|building=hotel|leisure=resort)$/,
    tags: ['tourism:hotel', 'tourism:hostel', 'tourism:guest_house', 'tourism:motel', 'tourism:apartment'] },
  { word: /\bnight ?market\b|夜市/i, ok: /^(amenity=marketplace|place=|landuse=(retail|commercial)|highway=(pedestrian|residential|living_street)|tourism=attraction)/,
    tags: ['amenity:marketplace', 'tourism:attraction', 'place:square'] },
  { word: /\b(train |railway |rail |mrt |metro |subway |hsr |bus )?station\b|車站|火車站|捷運站|駅/i, ok: /^(railway=(station|halt|stop)|public_transport=station|building=(train_station|transportation)|amenity=bus_station)$/,
    tags: ['railway:station', 'railway:halt', 'public_transport:station', 'amenity:bus_station'] },
  { word: /\bairport\b|機場|空港/i, ok: /^aeroway=/, tags: ['aeroway:aerodrome', 'aeroway:terminal'] },
  // An open place: a garden, a park or a square is that kind of place, never a museum, a shop or a street named after
  // it ("Murillo Gardens" found the Casa de Murillo museum first and the gardens third). The kind is the name's last
  // word in English and German ("Hyde Park", "Murillo Gardens", "Trafalgar Square") and its first in the Romance
  // languages ("Jardines de Murillo", "Parque do Ibirapuera", "Piazza Navona"), so "Park Lane" and "Park Hyatt" name no
  // park. A zoo, a theme park, an arena or a sight of that name is that place too ("Jardim Zoológico" is the zoo, a
  // "plaza de toros" a bullring). After a hotel, a station or an airport ("Plaza Hotel"), before the kinds a garden or a
  // square is named after ("Museum Gardens", "Square du Temple"). Never for a place to stay, nor with --kind: they say
  // what the place is ("open")
  { open: true, word: /^\s*(jard[ií]n(es)?|jardim|jardins|giardin[oi]|parque|parc|parco)\b|\b(gardens?|(?<!\bcar[\s-])park|garten)\s*(?=[,，]|$)|(公園|公园|庭園|花園|花园)\s*(?=[,，]|$)/i,
    ok: /^(leisure=(park|garden|nature_reserve|common|recreation_ground|dog_park|water_park|stadium)|tourism=(attraction|zoo|theme_park|aquarium)|boundary=(national_park|protected_area)|landuse=(recreation_ground|village_green|grass|meadow|forest|cemetery))$|^natural=/,
    tags: ['leisure:park', 'leisure:garden'] },
  { open: true, word: /^\s*(plaza|pra[cç]a|piazza|piazzale|largo|square)\b|\b(square|platz)\s*(?=[,，]|$)|(廣場|广场)\s*(?=[,，]|$)/i,
    ok: /^(place=(square|locality)|highway=(pedestrian|footway|living_street)|leisure=(park|garden|common|stadium)|tourism=(attraction|viewpoint)|amenity=marketplace|landuse=(village_green|recreation_ground))$|^area:highway=/,
    tags: ['place:square', 'highway:pedestrian'] },
  { word: /\b(museum|gallery)\b|博物館|美術館/i, ok: /^(tourism=(museum|gallery|attraction)|building=museum|amenity=arts_centre)$/, tags: ['tourism:museum', 'tourism:gallery'] },
  { word: /\b(temple|shrine)\b/i, ok: /^(amenity=place_of_worship|historic=|building=(temple|shrine|religious)|tourism=attraction)/, tags: ['amenity:place_of_worship'] },
  { word: /\buniversity\b|大學/i, ok: /^(amenity=(university|college)|building=university)$/, tags: ['amenity:university'] },
  { word: /\bhospital\b|醫院/i, ok: /^(amenity=(hospital|clinic)|building=hospital|healthcare=)/, tags: ['amenity:hospital'] },
];
/** The kind of place a query names ("… Station", "Murillo Gardens"), or null. `open: false` leaves out the open places
 *  (a garden, a park, a square): a place to stay or a --kind says what the place is. */
export function queryType(q, { open = true } = {}) { return TYPE_WORDS.find((t) => (open || !t.open) && t.word.test(q)) || null; }
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

/** nameMatches, but a candidate whose own name (or English name) is the query's name, accents, case and punctuation
 *  aside (the part before a comma, as in nameCloseness), is a match even when each word of it is generic or also names
 *  the area: "Plaza de España, Seville" is the square of that name ("plaza" a generic word, "España" the country) and
 *  "Triana, Seville" the district the other hits lie in. Pure; exported for the tests. */
export function nameMatchFor(query, names, area = []) {
  return nameCloseness(query, names, area) === 3 ? true : nameMatches(query, names, area);
}

/** How closely a candidate's own name (or its English name) is the place the query names, not only a name that
 *  contains it: 3 the same name; 2 every distinctive word of the query and no word the query does not have; 1 the
 *  query's words and more ("Miradouro do Padrão dos Descobrimentos", the viewpoint named after "Padrão dos
 *  Descobrimentos"; "Hôtel du Sacré-Cœur", a hotel named after the church); 0 otherwise. Accents, case and
 *  punctuation do not count, nor words that only name the area (`area`, as in nameMatches) or words of three letters
 *  or fewer (de, dos, the). Generic words (hotel, museum …) never make a match, but a name's generic word the query
 *  does not have is a word more: a hotel or café named after a place is not that place. Only the part of the query
 *  before a comma is the name ("Padrão dos Descobrimentos, Lisboa"). Pure; exported for the tests. */
export function nameCloseness(query, names, area = []) {
  const norm = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const label = norm(String(query || '').split(/[,，]/)[0]);
  if (!label) return 0;
  const areaTokens = new Set(area.filter(Boolean).flatMap((a) => norm(a).split(' ')));
  const words = (x, generic = false) => new Set(x.split(' ').filter((t) => (t.length >= 4 || /^\d+$/.test(t)) && (generic || !GENERIC.has(t)) && !areaTokens.has(t)));
  const want = words(label);
  const said = words(label, true);
  let best = 0;
  for (const n of names.filter(Boolean).map(norm)) {
    if (n === label) return 3;
    if (!want.size) continue;
    const have = words(n, true);
    if (![...want].every((t) => have.has(t))) continue;
    best = Math.max(best, [...have].every((t) => said.has(t)) ? 2 : 1);
  }
  return best;
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
    // its outline, for a "not found" entry whose place this is under another name (missing.mjs missedPlace); not
    // printed with the candidate
    Object.defineProperty(c, 'bbox', { value: [Math.min(w, e), Math.min(n, s), Math.max(w, e), Math.max(n, s)], enumerable: false });
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

/** `turn`: the turn's clock, as uw.mjs gives it to validate ({ turnLeftS, turnStartedMs }). */
export async function addPoint(argv, turn = {}) {
  const ctx = { turn };
  try { return await addPointRun(argv, ctx); } catch (e) {
    // out of time or unavailable (the search / Overpass busy or down): the place is still listed as "Not found yet", so the reply can say so
    if (isSkip(e) && ctx.site && ctx.args?.query) {
      const who = ctx.args.name || queryLabel(ctx.args.query);
      const { listed, pinned, with: same, stays } = noteMissing(ctx.site, { layer: ctx.layer, id: ctx.args.id, name: who, query: ctx.args.query,
        tried: [...(ctx.tried || []), `${e.service || 'search'} (busy: skipped)`], replacing: ctx.replacing });
      // a place a pin already is is not listed (noteMissing): said as it is, never as listed
      if (pinned) e.kept = `nothing new: "${who}" is on the map already as ${pinned.layer}:${pinned.id}${pinned.names[0] && pinned.names[0] !== who ? ` ("${pinned.names[0]}")` : ''}`;
      else if (listed) e.kept = (same ? `"${who}" kept as "Not found yet" on the map, once, with "${same}" (the same place)` : `"${who}" listed as "Not found yet" on the map`)
        + (stays ? `, by its name: ${stays.layer}:${stays.id} stays as it was` : '');
    }
    throw e;
  }
}
async function addPointRun(argv, ctx) {
  const args = parseArgs(argv, { layer: 'string', query: 'string', near: 'string', id: 'string', name: 'string', emoji: 'string',
    note: 'string', props: 'string', 'props-file': 'string', pick: 'number', 'allow-far': 'bool', 'allow-mismatch': 'bool', 'max-km': 'number', at: 'string', lang: 'string', kind: 'string', osm: 'string',
    source: 'string', tier: 'string', 'no-fit': 'bool', country: 'string', 'strict-name': 'bool', replace: 'bool' },
  { positionals: [1, 1], command: 'add-point' });
  if (args.help) return console.log(helps.addPoint);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  Object.assign(ctx, { site, layer, args });
  // the pin under this run's own id that was there when it began, with --replace: the pin it was to replace (a wrong
  // match). Any other pin under its id is that id's place (noteMissing): one pinned while this lookup still ran, too
  ctx.replacing = !!args.replace && !!args.id && (() => { try { return (loadLayer(site, layer, { required: false })?.features || []).some((f) => String(f?.properties?.id) === String(args.id)); } catch { return false; } })();
  const extra = propsArg(args);
  if (!args.query && !args.at && !args.osm) throw new UsageError('give --query "<place name or street address>" (or --osm <osm id>, or --at lng,lat --name "…" for coordinates the user provided)');
  if ([args.query, args.at, args.osm].filter(Boolean).length > 1) throw new UsageError('use one of --query, --osm or --at');
  const source = sourceArg(args.source);
  if (args.source && !args.query) throw new UsageError('--source only applies to --query');
  if (args.tier && !TIERS.includes(args.tier)) throw new UsageError('--tier must be option, support or context');
  // a place looked for: a refused plan keeps a day with one place only once the turn has looked for another after the
  // refusal (cmd-plan.mjs refusedPlan)
  if (!handoffStep()) (await import('./cmd-plan.mjs')).noteLookupTried(site.dir, layer);
  // a source_url no uw cite read is read here, as uw cite would read it (cmd-cite.mjs readSource): a turn pinned a
  // sight with its article, was refused ("cite it first"), cited it and pinned it again, a round trip a place, and its
  // last pin was refused that way as its time ran out. Once read, the page is judged as one uw cite read: by the
  // place's names, once it is found (sourceNotOwn below). One that cannot be read (refused, HTTP 404, no answer in
  // time), or that is not a page, is refused before any lookup: nothing is written, and the place is not "not found
  // yet"
  const askedName = args.name || queryLabel(args.query || '') || extra.name || '<its name>';
  let notRead = handoffStep() ? null : sourceNotRead(extra.source_url);
  let readNow = null;
  if (notRead && !notRead.not_page) {
    readNow = await readSource(extra.source_url);
    notRead = readNow.failed ? { url: extra.source_url, failed: readNow.failed } : sourceNotRead(extra.source_url);
  }
  if (notRead) {
    const { lines, refused, next } = sourceNotReadRefusal(notRead, askedName, 'Nothing was added.');
    if (out.json) process.stdout.write(JSON.stringify({ ok: false, refused, layer, id: args.id || null, source_url: extra.source_url, ...(notRead.failed ? { why: notRead.failed } : {}), next }, null, 2) + '\n');
    console.error(lines.join('\n'));
    return 2;
  }
  if (readNow?.read) console.error(readSourceLine(readNow.read, askedName));

  let chosen, cands = [], skipped = [], warnings = [], reg = null, regUsed = false;
  const tried = [];
  ctx.tried = tried;
  // a place that could not be added is listed on the map as "not found yet" (map.config.json "missing") until it is
  const refuse = (code, lines, json, place = null) => {
    const missName = args.name || queryLabel(args.query || '');
    const { pinned, with: same, stays } = noteMissing(site, { layer, id: args.id, name: missName, query: args.query, tried, place, replacing: ctx.replacing });
    // a researched sight (--strict-name) ends on the trip guide's own rule, not only on another try: one sight tried
    // four times left the trip's other days without a sight. A place to stay is not a sight (`uw handoff` lists its
    // researched hotels itself)
    const next = args['strict-name'] && !isLodging({ kind: args.kind || extra.kind, layer }) && !pinned ? STRICT_NEXT : null;
    if (out.json) process.stdout.write(JSON.stringify({ ...json, ...(pinned ? { pinned_as: `${pinned.layer}:${pinned.id}` } : {}), ...(next ? { next } : {}) }, null, 2) + '\n');
    // pinned by its OpenStreetMap object under another name, the place stayed "Not found yet" beside its own pin: the
    // entry goes under the id, a name or the query it was looked up by, and when that object, or another object of
    // that place, is pinned (missing.mjs); a place pinned already is not listed. The business a sight's lookup just
    // refused (named after the place) is never offered as that object
    const elsewhere = json?.refused === 'named_after' ? `one uw geocode finds by that name, never the ${json.found?.kind === 'sign' ? 'board or sign' : json.found?.kind === 'street' ? 'street' : 'business'} above` : 'an object above, or one uw geocode finds by that name';
    // a pin under this lookup's own id: the id is on the map, whatever that pin is called (a lookup that hung was
    // answered after the same place had been pinned under its id by another name, and listed it beside its own pin)
    const ownId = !!pinned && !!args.id && pinned.layer === layer && String(pinned.id) === String(args.id);
    const listLine = ownId ? `Not listed as "not found yet": ${pinned.layer}:${pinned.id}${pinned.names[0] ? ` ("${pinned.names[0]}")` : ''} is on the map under this id. Another place than "${missName}"? Look it up under an id of its own.`
      : pinned ? `Not listed as "not found yet": ${pinned.layer}:${pinned.id}${pinned.names[0] ? ` ("${pinned.names[0]}")` : ''} is that place, on the map already.`
      : `${same ? `Listed on the map as "not found yet" once (map.config.json "missing"), with "${same}": the same place, looked up before.` : 'Listed on the map as "not found yet" (map.config.json "missing").'}`
        // (the pin this run was to replace stays: the place is listed by its name, never beside that pin under its id)
        + `${stays ? ` By its name: ${stays.layer}:${stays.id}${stays.names[0] ? ` ("${stays.names[0]}")` : ''} stays on the map under that id as it was, until a lookup under that id with --replace finds the place.` : ''}`
        + ` In OpenStreetMap under another name (${elsewhere})? Pin that object under the ${args.id ? 'id and name' : 'name'} it was looked up by, which takes it off the list: ${pinAs(args, layer)}, with the same props.`;
    console.error([...lines, listLine, ...(next ? [next] : [])].join('\n'));
    return code;
  };
  // An item of a listing (what's on: a match, a concert, a market) is pinned at the venue its listing names, under its
  // own name, with its date in its note: a search for the event's own name finds a street, a shop or a pub named like it,
  // never where it is (a football match was pinned on a residential street that shares the opponent's name). One
  // looked up by its own name is refused before any lookup and listed as not found yet under that name, which the
  // reply names; its venue's lookup then takes the entry off
  if (LISTING_LAYER.test(layer) && args.query && !handoffStep()) {
    const item = String(args.name || '').trim();
    const town = String(args.query).split(/[,，]/).slice(1).join(',').trim();
    const form = `uw add-point ${args._[0]} --layer ${layer} --query "<the venue its listing names>${town ? `, ${town}` : ''}" --name "${(item || '<the item>').replace(/(["\\$`])/g, '\\$1')}" --note "<its date>"${args.id ? ` --id ${args.id}` : ''}`;
    if (!item) throw new UsageError(`an item of a listing (layer ${layer}) is pinned at its venue under its own name: ${form}, with the listing as its source ({"source_url":"<the listing>","source":"<site>"})`);
    if (holdsName(item, [queryLabel(args.query)]) === true) {
      tried.push('nothing yet: it is looked up by its venue');
      return refuse(2, [`REFUSED: "${item}" was looked up by its own name: an item of a listing is pinned at the venue its listing names, never where a search finds its name (a street or a shop named like it). Nothing was looked up.`,
        `Look up its venue, keeping its name and its date: ${form}, with the listing as its source.`],
      { ok: false, refused: 'item_by_its_name', query: args.query, name: item, next: form });
    }
  }
  // A place looked up by its own name is the place of that name: one of its own names, in any language it carries,
  // holds every word of it that tells it from another of its kind (names.mjs holdsName), and its kind fits. A hotel
  // looked up by its name was pinned as another of its chain that shared one word of it, and another as a hotel that
  // shared only "Boutique": a business or a venue matches only by its name. --strict-name asks for that; it is the
  // default for a named place: a lookup by a name, never by a street address (a house number in it), for a city or a
  // stop, or by another name than the place's (--name names a place the query is not: its address, its local name).
  // An item of a listing is looked up by its venue's name
  const looksAddress = !!args.query && ADDRESS_QUERY.test(args.query);
  const nameElsewhere = !!args.name && !LISTING_LAYER.test(layer) && holdsName(args.name, [queryLabel(args.query || '')]) === false;
  const stopLookup = /^(city|town|village|place)$/i.test(String(args.kind || '')) || Number.isInteger(extra.nights);
  const namedPlace = !!args.query && !looksAddress && !nameElsewhere && !stopLookup && source !== 'registry';
  const strict = !!args['strict-name'] || namedPlace;
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
    // the kind of place the query names; a garden, a park or a square only when neither --kind nor a place to stay
    // says what it is ("Park Plaza" is a hotel in a stays layer)
    const qType = queryType(args.query, { open: !(args.kind || extra.kind) && !isLodging({ query: args.query, layer }) });
    // the area is where the place can be: the hits in range. A far-off hit's town never turns the query's own words
    // into area words ("Real Alcázar de Sevilla" also found streets in Alcázar de San Juan, Ciudad Real)
    const inRange = cands.filter((c) => !tooFar(c));
    const area = areaWordsOf(inRange.length ? inRange : cands);
    // --kind city|town|village|place: a place object, never a shop or a station that carries the city's name
    // ("Tokyo Shoes Retailing Center" for Tokyo)
    const placeKind = /^(city|town|village|place)$/i.test(String(args.kind || '')) ? /^place[=:]/ : null;
    // how closely a candidate's own name is the place the query names (3: that very name)
    const closeness = (c) => nameCloseness(args.query, [c.name, c.name_en], area);
    // A garden, a park or a square the name's head word suggests ("open") decides between the places named like the
    // query, never what is named like it: its kind word is not part of the name ("Phoenix Garden" shares only "Garden"
    // with "Covent Garden", and was taken for it), and a place whose own name is the query's matches whatever its kind
    const nameOf = (q, c) => (qType?.open
      ? (closeness(c) === 3 ? true : nameMatches(stripType(q, qType), [c.name, c.name_en], area))
      : nameMatchFor(q, [c.name, c.name_en], area));
    // a named place: one of its own names (its name, its English name, the other names OpenStreetMap keeps, once they
    // were looked up below) holds every word of the query's name that tells it apart; an open place's kind word is
    // judged by its kind, never as a word of its name ("Main Square" holds "Main Market Square": the square)
    const holds = (c) => holdsName(args.query, [c.name, c.name_en, ...(Array.isArray(c.other_names) ? c.other_names : [])], area, { type: c.type, strip: qType?.open ? qType.word : null });
    const judge = (c) => {
      if (!strict || args.pick !== undefined) return;
      c.holds = holds(c);
      if (c.holds === true) c.name_match = true;
      else if (c.holds === false) { c.shares = c.name_match === true; c.name_match = false; }
    };
    // a street is never a venue, a sight or a place to stay: only a lookup that asks for a street (its words, --kind) or
    // names that very street takes one ("Brentford Street" for a match against Brentford)
    const streetAsked = STREET_ASKED.test(`${queryLabel(args.query)} ${args.kind || ''} ${extra.kind || ''}`);
    const streetRule = !looksAddress && (strict || SIGHT_LAYER.test(layer) || LISTING_LAYER.test(layer) || OPTION_LAYER.test(layer));
    const annotate = (list, q) => { for (const c of list) {
      c.name_match ??= nameOf(q, c);
      judge(c);
      if (qType?.open) { c.kind_ok = qType.ok.test(c.type || ''); c.type_ok = null; }
      else c.type_ok = qType ? qType.ok.test(c.type || '') : placeKind ? placeKind.test(c.type || '') : null;
      // a playground, a car park … in the place the query names is not that place, unless the query asks for one
      if (STANDS_IN.test(c.type || '') && !kindAsked(c, args.query, args.kind, extra.kind)) { c.type_ok = false; c.stands_in = true; }
      // a sight's lookup: a hotel, a restaurant or a shop named after it is not it either ("Hotel Castle Garden" for the
      // bazaar, the restaurant "De Graslei" for the quay), unless the lookup asks for that kind, its own name adds
      // nothing to the query's words (a famous café asked for by its name, "The <name>"), or a shop's adds only its
      // branch (a store asked for by its own name). Any other lookup (a listing's venue, a list of bars) takes the
      // business its query names: an event at "Mikkeller" is at the bar "Mikkeller Bar"
      const biz = SIGHT_LAYER.test(layer) ? businessOf(c) : null;
      if (biz && c.type_ok !== false && !nameWithinQuery(args.query, [c.name, c.name_en], area) && !(biz === 'shop' && branchOfQuery(args.query, [c.name, c.name_en], area))
        && !kindAsked(c, args.query, args.kind, extra.kind) && !businessAsked(biz, { query: args.query, kind: args.kind || extra.kind })) { c.type_ok = false; c.named_after = biz; }
      // nor is a board or a sign that only carries its name (the information board by a parliament was pinned as the
      // parliament): never the sight, whatever its name, unless the lookup asks for a board
      if (SIGHT_LAYER.test(layer) && c.type_ok !== false && SIGN_TYPE.test(c.type || '') && !kindAsked(c, args.query, args.kind, extra.kind)) { c.type_ok = false; c.named_after = 'sign'; }
      if (streetRule && !qType && c.type_ok !== false && STREET_TYPE.test(c.type || '') && !streetAsked && closeness(c) < 3) { c.type_ok = false; c.named_after = 'street'; }
    } };
    annotate(cands, args.query);
    // --allow-far: distance never decides (a stop far from the map's first view is still that stop)
    const reachable = (c) => args['allow-far'] || !tooFar(c);
    // every name the place carries: when no candidate in range holds the name by its name or its English name, the
    // other names OpenStreetMap keeps for those that share a word of it (its official, other and short names, in every
    // language) are looked up once, in at most 12 s, and judged the same way. Busy or down: judged by what the search gave
    if (strict && args.pick === undefined && !cands.some((c) => reachable(c) && c.holds === true)) {
      const some = cands.filter((c) => reachable(c) && c.shares && c.osm_id).slice(0, 6);
      if (some.length) {
        try {
          const names = await withCap(12000, () => osmNames(some.map((c) => c.osm_id)));
          for (const c of some) { c.other_names = names.get(c.osm_id) || []; c.name_match = c.shares; judge(c); }
        } catch (e) { if (isSkip(e)) warnings.push(`the other names of ${some.map((c) => `"${c.name}"`).join(', ')} could not be looked up (${e.message}): judged by the names the search gave`); }
      }
    }
    const good = (c) => reachable(c) && c.name_match !== false && c.type_ok !== false;
    // (also with --pick, so the numbers in a refusal and in --pick always mean the same list)
    if (cands.length && qType && !cands.some((c) => good(c) && (!qType.open || c.kind_ok))) {
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
      // nothing else fits: a place asked for by its own name is that place, even of a kind that usually only stands in
      // another and takes its name (a car park asked for by its name), unless the query or --kind names another kind
      if (idx < 0 && !qType && !placeKind) {
        idx = cands.findIndex((c) => c.stands_in && reachable(c) && !PART_TYPE.test(c.type || '') && closeness(c) === 3);
        if (idx >= 0) { cands[idx].type_ok = null; delete cands[idx].stands_in; }
      }
      if (idx < 0) idx = cands.findIndex((c) => !tooFar(c));
      if (idx > 0) skipped = cands.slice(0, idx).filter((c) => tooFar(c));
      chosen = idx >= 0 ? cands[idx] : cands[0];
      // The place itself before a place named after it, whatever order the search gave: "Padrão dos Descobrimentos"
      // is the monument, not "Miradouro do Padrão dos Descobrimentos" (the viewpoint on it). Only a candidate that is
      // the same name (or every word of it and no other) wins over one that merely contains it; a station or stop
      // never wins this way unless the query asks for one ("Sagrada Família" is the church, not its metro station).
      // the query (or --kind) asks for a kind of transit: a station may be the place asked for
      const transitAsked = (qType?.tags || []).some((t) => /^(railway|public_transport|aeroway|amenity:bus_station)/.test(t)) ||
        /station|stop|airport|terminal|metro|mrt|subway|rail|hsr/i.test(String(args.kind || ''));
      if (idx >= 0) {
        const mine = closeness(chosen);
        const named = cands.map((c) => ({ c, k: closeness(c) }))
          .filter(({ c, k }) => k >= 2 && k > mine && good(c) && !tooFar(c) && !PART_TYPE.test(c.type || '') && (transitAsked || !TRANSIT_TYPE.test(c.type || '')))
          .sort((a, b) => b.k - a.k)[0];
        if (named) chosen = named.c;
      }
      // Same place mapped twice (e.g. landuse/building outline + the tourism=hotel object): prefer the POI,
      // or the candidate whose OSM value equals --kind. Never "upgrade" to an entrance, platform or stop
      // (大安森林公園站 matched the station building, then moved to exit 1), nor away from a place in its own right
      // (place=*: a square, a quarter, a town): an object of its name there stands in it (an artwork on the square, a
      // shop named after the quarter), so the place keeps the kind it is (a square showed as "Artwork"). A locality
      // only names a spot, and a dwelling, a farm or a plot is one building or holding: an object of its name there is
      // the same place mapped twice (a farmhouse hotel), so the object is the better match.
      const poiKey = /^(tourism|amenity|shop|leisure|railway|public_transport|historic|aeroway|natural|office|craft|healthcare|club|sport)=/;
      const ownPlace = /^place=(?!(?:locality|isolated_dwelling|farm|plot)$)/.test(chosen.type || '');
      const better = cands.find((c) => c !== chosen && !tooFar(c) && c.name_match !== false && c.type_ok !== false && haversine(c.coord, chosen.coord) < 300 &&
        !PART_TYPE.test(c.type || '') &&
        (args.kind ? c.kind === args.kind && chosen.kind !== args.kind : !ownPlace && poiKey.test(c.type) && !poiKey.test(chosen.type || '') && !(exactName(args.query, chosen) && !exactName(args.query, c)) && !(closeness(chosen) > closeness(c))));
      if (better) chosen = better;
      // the chosen one is a part (entrance, platform, stop) but the station / main object is listed too: take that
      if (PART_TYPE.test(chosen.type || '')) {
        const main = cands.find((c) => c !== chosen && !tooFar(c) && c.name_match !== false && !c.named_after && !PART_TYPE.test(c.type || '') && haversine(c.coord, chosen.coord) < 400);
        if (main) chosen = main;
      }
      // The kind the name's head word suggests (a garden, a park, a square), when the pick is not of it: the place of
      // that kind with the query's very name; else another place with that very name, whatever its kind (the quarter
      // "Covent Garden", the district "Parque das Nações", a street, a market or a hall of that name; never a station,
      // a hotel or a car park named after it); else the place of that kind whose name carries the query's own words
      // ("Murillo Gardens": the Jardines de Murillo, not the Casa de Murillo museum the search listed first); else
      // nothing fits: refused below with the alternatives
      if (qType?.open && !chosen.kind_ok) {
        const fits = (c) => reachable(c) && !PART_TYPE.test(c.type || '');
        const same = (c) => closeness(c) === 3;
        const namedAfter = (c) => c.stands_in || (TRANSIT_TYPE.test(c.type || '') && !transitAsked) || isLodging({ kind: c.kind });
        const next = cands.find((c) => fits(c) && c.kind_ok && same(c))
          || [chosen, ...cands].find((c) => fits(c) && !namedAfter(c) && same(c))
          || cands.find((c) => fits(c) && c.kind_ok && c.name_match === true);
        if (next) chosen = next;
        else chosen.type_ok = false;
      }
      // A station is named after the place it serves, so it is never that place unless the query asks for transit:
      // "Rossio" is the square, and the station by it is "Rossio" too. The square is often mapped under another name
      // ("Praça Dom Pedro IV", "Rossio" its other name), so the search lists only the station. The place of that name
      // is looked for among squares and places to walk to next to the station, and taken only when that is its name:
      // its own, or one of its other names in OpenStreetMap. The search's filtered answer also lists places that only
      // share a word with it or a city ("St Pancras Lock"; parks across Paris for "Gare du Nord, Paris"): those are
      // not it, and the station stays.
      if (!transitAsked && !placeKind && !geocodeDegraded() && STATION_TYPE.test(chosen.type || '') && closeness(chosen) >= 2) {
        const station = chosen;
        const fromStation = (c) => haversine(c.coord, station.coord);
        let nearby = [];
        try {
          const places = await geocodeSearch(args.query, { near: station.coord, limit: 6, lang: args.lang || 'default', tags: NAMED_PLACE_TAGS, onEmpty: 'stop' });
          nearby = places.filter((c) => NAMED_PLACE_TYPE.test(c.type || '') && fromStation(c) <= NAMED_PLACE_M && !tooFar(c))
            .sort((a, b) => fromStation(a) - fromStation(b));
        } catch (e) { if (isSkip(e)) warnings.push(`"${station.name}" is a station; the place it is named after could not be looked up (${e.message})`); }
        // its own name is the one asked for, else one of its other names (one Overpass lookup for all of them)
        let place = nearby.find((c) => closeness(c) >= 2) || null;
        if (!place && nearby.some((c) => c.osm_id)) {
          try {
            const names = await osmNames(nearby.map((c) => c.osm_id).filter(Boolean));
            place = nearby.find((c) => nameCloseness(args.query, names.get(c.osm_id) || [], area) >= 2) || null;
          } catch (e) {
            const c = nearby[0];
            warnings.push(`"${station.name}" is a station; whether ${c.name} [${c.type}], ${Math.round(fromStation(c))} m from it, is the place it is named after could not be checked (${e.message}): the station was kept. If that place is meant: add-point ${args._[0]} --layer ${layer} --osm ${c.osm_id} --name "${queryLabel(args.query)}"`);
          }
        }
        if (place) {
          if (near) place.distance_km = Math.round(haversine(near, place.coord) / 10) / 100;
          // known by the name asked for, which its own name may not carry: that name is the one the map shows
          if (nameMatches(args.query, [place.name, place.name_en], area) !== true) place.name_en = queryLabel(args.query);
          Object.assign(place, { name_match: true, type_ok: null });
          cands.push(place);
          chosen = place;
          out.log(`"${station.name}" is a station [${station.type}]; took the place it is named after: ${place.name} [${place.type}], ${Math.round(fromStation(place))} m from it (--pick N takes the station).`);
        }
      }
    }
    // A board or a sign carries the query's name, and what was chosen instead is itself named after the place: a
    // business, an office or a stop whose name has the query's only among other words (an office "<Name> Youth …"
    // beside the board "The <Name>"), or a stop, a platform or an entrance that only serves the place, whatever its
    // name (the bus stop "<Name>" beside the board: a stop is chosen only for want of the place itself). The place
    // itself is not among the candidates: the board is what was found, and the lookup is refused below, saying so;
    // --pick N takes a candidate that is the place. A place of any other kind stays chosen (a building "<Name>" for
    // "The <Name>", a museum "Galleria of <Name>" for "<Name>"): it is the sight, and the board beside it hides nothing
    if (chosen && !regUsed && args.pick === undefined && !chosen.named_after) {
      const sign = cands.filter((c) => c.named_after === 'sign' && reachable(c)).sort((a, b) => closeness(b) - closeness(a))[0];
      const serves = PART_TYPE.test(chosen.type || '') && !kindAsked(chosen, args.query, args.kind, extra.kind);
      const namedAfter = namedAfterKind(chosen) && !nameWithinQuery(args.query, [chosen.name, chosen.name_en], area) && closeness(chosen) < closeness(sign || {});
      if (sign && closeness(sign) >= 2 && (serves || namedAfter)) chosen = sign;
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
      // the only ones named like the query stand in that place (a playground there takes its name): that is why. A
      // street or a shop named like it is not one: then the name or the kind is why
      const namedLike = cands.filter((c) => c.name_match === true && !tooFar(c));
      const standing = !mismatch || cands.some(good) ? null : chosen.stands_in ? chosen
        : namedLike.length && namedLike.every((c) => c.stands_in) ? namedLike[0] : null;
      // what the lookup found is a business named after the place (a hotel, a restaurant, a shop), and nothing that is it
      // (a board or a sign chosen above is what was found, whatever else is listed)
      const business = !mismatch || standing ? null : chosen.named_after === 'sign' ? chosen : cands.some(good) ? null : chosen.named_after ? chosen : namedLike.find((c) => c.named_after && c.named_after !== 'street') || null;
      const isSign = business?.named_after === 'sign', isStreet = business?.named_after === 'street';
      // a named place none of whose candidates holds its name: the ones that share a word of it are other places
      const sharers = mismatch === 'name' && strict && !standing && !business ? cands.filter((c) => c.shares && reachable(c)) : [];
      if (mismatch && args.pick === undefined && !args['allow-mismatch']) {
        const target = SIGHT_LAYER.test(layer) ? 'the sight' : LISTING_LAYER.test(layer) ? 'the venue' : 'the place';
        const what = standing ? `"${standing.name}" [${standing.type}] only stands in the place "${args.query}" names and takes its name; no other candidate is named like it`
          : business ? `found ${isSign ? signWord(business) : businessWord(business)} named "${business.name}"${business.name_en && business.name_en !== business.name ? ` (${business.name_en})` : ''} [${business.type}], not ${isStreet ? target : 'the sight'} "${queryLabel(args.query)}" `
            + `(${isSign ? 'a board or a sign that carries a place\'s name is not that place' : isStreet ? 'a street is never a venue, a sight or a place to stay named like it' : 'a hotel, a restaurant or a shop named after a place is not that place'})`
          : sharers.length ? `no candidate's own name is "${queryLabel(args.query)}": ${sharers.slice(0, 3).map((c) => `"${c.name}"`).join(', ')} only share${sharers.length === 1 ? 's' : ''} a word of it (a place looked up by its name is the place of that name, never another of its kind)`
          : mismatch === 'name' ? `no candidate's name looks like "${args.query}"` : `no candidate nearby is the kind of place "${args.query}" names`;
        // the search does not index old / alternative names; OSM often keeps them (disused:name=亞士都飯店 on the renamed hotel)
        const alt = near && mismatch === 'name' ? await altNameSearch(args.query, near).catch(() => []) : [];
        if (near && mismatch === 'name') tried.push('OpenStreetMap old/alternative names (Overpass)');
        return refuse(2, [business || sharers.length ? `REFUSED: ${what}:` : `REFUSED: ${what} (best in range: "${chosen.name}${chosen.name_en ? ' / ' + chosen.name_en : ''}" [${chosen.type}]):`,
          ...cands.map(fmtCand), ...altLines(alt, args, layer), ...regLines(),
          'Nothing was written. The place may be missing from OpenStreetMap or named differently. Try the local-language or official name,',
          'or geocode its street address (from the user or the official listing): --query "<street address>" --name "<name>" --props \'{"source":"…"}\'.',
          'If one candidate IS the place, re-run with --pick N. (--allow-mismatch accepts the best one as is.)'],
        { ok: false, refused: standing ? 'stands_in' : business ? 'named_after' : mismatch + '_mismatch', query: args.query,
          ...(business ? { found: { name: business.name, type: business.type, kind: business.named_after } } : {}), candidates: cands, registry: reg?.candidates || [] },
        // the best match by another name, a square or a park this one's words name ("Main Square" for "Main Market
        // Square"): a pin of it later takes the entry off the list (missing.mjs)
        mismatch === 'name' && !standing ? missedPlace(chosen, { name: args.name || queryLabel(args.query || ''), query: args.query }) : null);
      }
      // a street address that resolved to a whole district or city is not the place (the search falls back to the area)
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
  // the name it was looked up by, when the place's own names differ ("Museo de Bellas Artes de Sevilla"): a page that
  // names it so names this place (uw set and uw validate judge its source_url with it too, with no request)
  const asked = args.query ? String(args.query).split(/[,，]/)[0].trim() : '';
  const foldName = (t) => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (asked && ![props.name, props.name_en, props.osm_name_en].some((n) => foldName(n) === foldName(asked))) props.looked_up_as = asked;
  Object.assign(props, extra);
  props.id = id; // --props cannot change the id silently
  // a mark that the person named the place ("asked") goes only on a place they named, once the map keeps their list
  // (uw new --asked): a turn marked a square it chose for the old town a message named, and lost the castle the message
  // named. In a later turn a place the person names then joins the list
  const askedList = props.asked === true && !handoffStep() ? askedOf(site.config) : [];
  const askedNow = askedList.length && !askedEntry(askedList, [...pinNames(props), args.name, queryLabel(args.query || '')], askedArea(site.config)) ? askedList : null;
  const unmarked = askedNow && namedThisTurn(askedNow, ctx.turn?.turnStartedMs ?? null) ? askedNow : null;
  if (unmarked) {
    delete props.asked;
    warnings.push(`not marked as a place the person named: they named ${unmarked.map((a) => `"${a.name}"`).join(', ')}, not "${args.name || queryLabel(args.query || '') || name}"; it is pinned as a place you chose (its own page counts it on its day)`);
  }
  const joinsAsked = !!askedNow && !unmarked;
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: chosen.coord.map(round6) }, properties: props };

  // the register's licence credit is loaded before the write lock is taken (no waiting inside it)
  const { ATTRIBUTION } = regUsed ? await import('../adapters/tw-hotels.mjs') : {};
  // read, change and write the layer and map.config.json under the site's write lock: another command (another stop
  // of handoff --apply) may write them at the same time
  const { rel, replaced, cfgChanges, def, cfg, pinned, unlisted, dayItems, notOwn, lateOwn, sourceMiss, stopTwin } = withSiteLock(site, () => {
    const p = layerPath(site, layer);
    let fc = { type: 'FeatureCollection', features: [] };
    if (exists(p)) {
      try { fc = readJSON(p); } catch (e) { throw new UserError(`${p} is not valid JSON (${e.message}); fix or delete it first`); }
      if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new UserError(`${p} is not a FeatureCollection`);
    }
    // one place, one pin: a pin of this place under another id (the same OpenStreetMap object or register listing, or
    // the same name a few steps away: another object of it) is that place's pin. Plaza de España was pinned again under
    // a new id to fill a third day, and a retry with --pick 2 could take its pedestrian way 97 m away. Refused, naming
    // that pin; --replace replaces that pin, keeping its id (the days and notes name it). This id's own pin comes first:
    // on a map that already holds the place twice, pinning it again under its own id replaces that pin
    // one stop per city (lib/stops.mjs): the city pinned beside its own station, or again under another id, is that
    // stop. Refused, naming it; --replace replaces that stop and keeps its id (the days and the stays name it)
    const twin = cityStopTwin(fc.features, feature);
    if (twin && !args.replace) {
      const cfgNow = readJSON(site.cfgPath);
      const before = (cfgNow.missing || []).length;
      clearMissing(cfgNow, { ...pinOfFeature(layer, feature, args.query), id: args.id ? String(args.id) : null }, siteArea(site, cfgNow));
      if ((cfgNow.missing || []).length < before) {
        if (!cfgNow.missing.length) delete cfgNow.missing;
        writeJSON(site.cfgPath, cfgNow, { pretty: true });
        site.config = cfgNow;
      }
      return { stopTwin: twin };
    }
    if (twin) { id = String(twin.properties.id); props.id = id; }
    const me = pinOf(feature, [chosen.name, chosen.name_en], { transit: TRANSIT_TYPE.test(chosen.type || '') || TRANSIT_KIND.test(String(props.kind ?? '')) });
    const own = fc.features.find((f) => String(f?.properties?.id) === id);
    const others = fc.features.filter((f) => f !== own && samePlace(pinOf(f), me));
    const ownIsIt = !!own && samePlace(pinOf(own), me);
    if (others.length && !ownIsIt && !args.replace) {
      // it is on the map: an earlier try of it under this id or name ("not found yet") is not missing any more
      const cfgNow = readJSON(site.cfgPath);
      const before = (cfgNow.missing || []).length;
      // (the place it found, by the id, names and query it was looked up by, its object and point, and the pin that is
      // it: an entry for either goes)
      const area = siteArea(site, cfgNow);
      clearMissing(cfgNow, { ...pinOfFeature(layer, feature, args.query), id: args.id ? String(args.id) : null }, area);
      clearMissing(cfgNow, pinOfFeature(layer, others[0]), area);
      const unlisted = (cfgNow.missing || []).length < before;
      if (unlisted) {
        if (!cfgNow.missing.length) delete cfgNow.missing;
        writeJSON(site.cfgPath, cfgNow, { pretty: true });
        site.config = cfgNow;
      }
      return { pinned: others[0], unlisted };
    }
    if (others.length && !ownIsIt) { id = String(others[0].properties.id); props.id = id; }
    const i = fc.features.findIndex((f) => String(f?.properties?.id) === id);
    const replaced = i >= 0;
    const prev = replaced ? fc.features[i] : null;
    // Same place again: keep metrics/notes added later (enrich, hand edits); moved: drop them (they are stale).
    const prevC = prev?.geometry?.type === 'Point' ? prev.geometry.coordinates : null;
    const same = !!prevC && haversine(prevC, feature.geometry.coordinates) < 25;
    if (same) feature.properties = { ...prev.properties, ...feature.properties };
    // a place the person named stays one when it is pinned again somewhere else (a wrong match moved under its id)
    else if (prev?.properties?.asked === true && feature.properties.asked === undefined) feature.properties.asked = true;
    // a page uw validate fails as not the place's own (it does not name the place, or another place cites it) is
    // refused before anything is written, judged with the place as it is written (cmd-set.mjs sourceNotOwn; a uw
    // handoff step's places were judged by its own source check). Anywhere else, or with too little time left to cite,
    // it is said: by its name, or the name it was looked up by, while the turn can still cite the place's own page
    const notOwn = handoffStep() ? null : sourceNotOwn(site, layer, feature, { ...ctx.turn, stamps: true });
    if (notOwn && !notOwn.late) return { notOwn };
    const sourceMiss = unnamedSource(feature.properties, [args.name]);
    if (others.length && ownIsIt) warnings.push(`the same place is also pinned in this layer as ${others.map((f) => `${layer}:${f.properties.id}`).join(', ')}: one place, one pin: ${others.map((f) => `uw set ${args._[0]} ${layer}:${f.properties.id} --remove`).join('; ')}`);
    if (replaced) {
      if (!same && Object.keys(prev?.properties || {}).length > Object.keys(feature.properties).length) warnings.push(`${id} moved; its old metrics were dropped. Re-run enrich for ${layer}.`);
      fc.features[i] = feature;
    } else fc.features.push(feature);
    // when its source was set: a page no uw cite read is judged only for a place whose source this turn set (uw validate)
    sourceStamp(feature.properties, prev?.properties);
    // the same spot under another id? (a renamed hotel listed twice, say; a pin of this place is named above)
    const close = fc.features.find((f) => f !== feature && !others.includes(f) && f?.geometry?.type === 'Point' && haversine(f.geometry.coordinates, feature.geometry.coordinates) < 30);
    if (close) warnings.push(`"${close.properties.id}" (${close.properties.name}) is within 30 m: same building? A place can be listed twice under an old and a new name.`);
    fc.uw = { ...(fc.uw || {}), cmd: fc.uw?.cmd || 'add-point', updated_at: new Date().toISOString() };
    writeGeoJSON(p, fc);
    const rel = p.slice(site.dir.length + 1);
    // pinned again under its id after the days were planned: its items in the days link its new page, as uw set does
    // (they kept linking the page it had before)
    const dayItems = prev ? withDayItems(site, layer, id, prev.properties || {}, feature.properties, { late: !!notOwn?.late }) : 0;

    // map.config.json: register the layer (so the point shows at once), drop its "not found yet" entry, add the
    // register's licence credit, and keep the options on screen
    const cfgChanges = [];
    const cfg = readJSON(site.cfgPath);
    site.config = cfg;
    let def = configLayer(site, layer);
    if (!def) {
      const tier = args.tier || (OPTION_LAYER.test(layer) ? 'option' : 'support');
      // no sign for the whole layer: each place draws its own (a layer's style.emoji is drawn on every place in it, and
      // the first place's sign was: a cathedral showed the castle of the palace pinned before it)
      def = { id: layer, title: titleCase(layer), type: 'points', data: layerRelPath(site, layer), tier, style: {}, list: true };
      if (tier !== 'option') { const col = colorFor(kind || layer); if (col) def.style.color = col; }
      cfg.layers = [...(Array.isArray(cfg.layers) ? cfg.layers : []), def];
      cfgChanges.push(`registered layer "${layer}" (tier ${tier})`);
    } else if (args.tier && def.tier !== args.tier) { def.tier = args.tier; cfgChanges.push(`set ${layer} tier to ${args.tier}`); }
    // a place the person names in a later turn joins the places they named
    if (joinsAsked && !askedEntry(askedOf(cfg), pinNames(feature.properties), askedArea(cfg))) {
      cfg.asked = [...askedOf(cfg), { name: String(feature.properties.name_en || feature.properties.name), at: new Date().toISOString() }];
      cfgChanges.push(`kept "${feature.properties.name_en || feature.properties.name}" among the places the person named`);
    }
    const missBefore = (cfg.missing || []).length;
    // its entry goes: under its id, a name or the query it was looked up by, or as the place another lookup found
    // under another name (missing.mjs: "Main Square" pinned by its local name took "Main Market Square" off)
    if (missBefore) clearMissing(cfg, pinOfFeature(layer, feature, args.query), siteArea(site, cfg));
    if ((cfg.missing || []).length < missBefore) cfgChanges.push('removed its "not found yet" entry');
    if (!cfg.missing?.length) delete cfg.missing;
    if (regUsed) {
      const list = Array.isArray(cfg.attribution) ? cfg.attribution : [];
      if (!list.includes(ATTRIBUTION)) { cfg.attribution = [...list, ATTRIBUTION]; cfgChanges.push('added the Taiwan open-data credit'); }
    }
    writeJSON(site.cfgPath, cfg, { pretty: true });
    return { rel, replaced, cfgChanges, def, cfg, dayItems, lateOwn: notOwn, sourceMiss };
  });
  if (stopTwin) {
    const ref = `${layer}:${stopTwin.properties.id}`;
    const theirs = stopTwin.properties.name_en || stopTwin.properties.name;
    const what = isCityStop(stopTwin.properties) ? 'the city itself' : 'its station';
    if (out.json) process.stdout.write(JSON.stringify({ ok: false, refused: 'already_a_stop', query: args.query || null, layer, id: args.id || null,
      stop: { id: String(stopTwin.properties.id), name: theirs || null } }, null, 2) + '\n');
    console.error([
      `REFUSED: "${name}" is this trip's stop already: ${ref}${theirs ? ` ("${theirs}", ${what})` : ` (${what})`}. One stop per city: nothing was added.`,
      `Use that stop: its id in uw plan --ids and uw stay --near ${ref} (a city visited twice is named twice in --ids, never pinned twice).`,
      `To make this pin the stop instead: the same command with --replace (it replaces ${ref} and keeps that id, so what names the stop still does).`,
    ].join('\n'));
    return 2;
  }
  if (pinned) {
    const ref = `${layer}:${pinned.properties.id}`;
    const theirs = pinned.properties.name_en || pinned.properties.name;
    const json = { ok: false, refused: 'already_pinned', query: args.query || null, layer, id: args.id || null,
      pinned: { id: String(pinned.properties.id), name: theirs || null }, osm_id: chosen.osm_id || null, ...(unlisted ? { missing_removed: true } : {}) };
    if (out.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
    console.error([
      `REFUSED: "${name}"${chosen.type ? ` [${chosen.type}]` : ''}${chosen.osm_id ? ` (${chosen.osm_id})` : ''} is already pinned in this layer as ${ref}${theirs && theirs !== name ? ` ("${theirs}")` : ''}: one place, one pin.`,
      `${unlisted ? 'Nothing was added; its "not found yet" entry is gone: it is on the map.' : 'Nothing was written.'} A day that needs another place takes a different place, from its own page.`,
      `To change that pin (its page, its reason): uw set ${args._[0]} ${ref} --props-file - with {"source_url":…,"source":…,"why":…}.`,
      `To pin it again from what this command found: the same command with --replace (it replaces ${ref} and keeps that id, so the days that name it still do).`,
    ].join('\n'));
    return 2;
  }
  if (notOwn) {
    const { lines, refused, next } = sourceNotReadRefusal(notOwn, notOwn.name || props.name_en || name, 'Nothing was added.', args._[0]);
    if (out.json) process.stdout.write(JSON.stringify({ ok: false, refused, layer, id, source_url: notOwn.url, next, ...(notOwn.shared ? { cited_by: notOwn.shared } : {}) }, null, 2) + '\n');
    console.error(lines.join('\n'));
    return 2;
  }
  if (lateOwn) warnings.push(lateSourceLine(lateOwn));
  else if (sourceMiss) warnings.push(unnamedSourceLine(sourceMiss, args._[0], `${layer}:${id}`));
  let view = null;
  const isOption = def.tier === 'option' || cfg.question?.options?.layer === layer;
  if (isOption && !args['no-fit']) {
    try { view = (await fitView(site, { out })).view; cfgChanges.push(`view framed on the options (zoom ${view.zoom})`); }
    catch (e) { warnings.push(`could not fit the view (${e.message}); run: uw fit ${args._[0]}`); }
  }
  // the days uw plan wrote as a draft in this turn (it refused days short of places): planned again with this place,
  // so the Plan tab has it even when the turn replies next (a turn pinned two places after a refused plan, its next
  // command hung, and it replied with days that had neither). Still a draft: the plan command the refusal named
  // replaces it as before (cmd-plan.mjs planDraftAgain)
  const { planDraftAgain, draftAgainLine } = await import('./cmd-plan.mjs');
  const replanned = planDraftAgain(site.dir, args._[0], ctx.turn);

  for (const w of warnings) out.warn(w);
  const partialNote = !regUsed && chosen.data_status === 'partial' ? partialLine(`${layer}:${id} ${name}`, chosen.data_reason || 'found by a fallback source', `check its place on the map; re-run this add-point later for the full answer`) : null;
  if (partialNote) console.error(partialNote);
  const altList = regUsed ? cands : cands.filter((c) => c !== chosen);
  out.result({ ok: true, ...(partialNote ? { status: 'partial', partial: partialNote } : { status: 'ok' }), layer, file: rel, id, replaced, source: regUsed ? 'registry' : args.at ? 'user' : args.osm ? 'osm' : chosen.provider || 'search',
    chosen: { ...chosen, name, id }, alternatives: altList, registry_alternatives: reg ? reg.candidates.filter((c) => c !== chosen) : [],
    warnings, config: cfgChanges, view, ...(dayItems ? { day_items: dayItems } : {}), ...(sourceMiss ? { source_not_named: sourceMiss } : {}), ...(replanned ? { planned_again: replanned } : {}) }, [
    `${replaced ? 'Replaced' : 'Added'} ${layer}:${id} — ${props.emoji} ${name}${props.name_en && props.name_en !== name ? ` (${props.name_en})` : ''}` +
      (regUsed ? ` [registry: ${chosen.name}${chosen.name_local ? ' / ' + chosen.name_local : ''} · licence ${chosen.registry.licence_id || '—'} · match ${chosen.confidence} on ${chosen.by.join('+')}]`
        : ` [${chosen.type || 'user point'}]`) +
      `${(regUsed ? props.address : chosen.address) ? ' — ' + (regUsed ? props.address : chosen.address) : ''} @ ${chosen.coord.join(',')}${chosen.distance_km != null ? ` (${chosen.distance_km} km from near)` : ''}`,
    regUsed ? `  source: ${props.prov.source}${props.prov.also ? ' + ' + props.prov.also : ''} (open data, as of ${props.prov.as_of || '?'}; coordinates as filed by the operator)` : null,
    regUsed && cands.length ? 'Place search candidates, not chosen (--source osm --pick N takes one):\n' + cands.map((c, k) => '    ' + fmtCand(c, k)).join('\n')
      : !regUsed && cands.length > 1 ? 'Alternatives (use --pick N to choose another):\n' + cands.map((c, k) => (c === chosen ? '  * ' : '    ') + fmtCand(c, k)).join('\n') : null,
    reg && reg.candidates.filter((c) => c !== chosen).length ? 'Register alternatives (--source registry --pick N):\n' + reg.candidates.map((c, k) => (c === chosen ? '  * ' : '    ') + fmtRegistryCand(c, k)).join('\n') : null,
    cfgChanges.length ? `map.config.json: ${cfgChanges.join('; ')}.` : null,
    dayItems && !replanned ? `Its ${dayItems === 1 ? 'item' : `${dayItems} items`} in the plan's days link${dayItems === 1 ? 's' : ''} ${feature.properties.source_url ? 'its page now' : 'no page now'}; the days are as they were.` : null,
    replanned ? draftAgainLine(replanned, 'with it') : null,
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

// map.config.json "missing": places the user asked for that are not on the map yet (shown as "Not found yet"); which
// pin is the place an entry names: missing.mjs
/** The site's pins (missing.mjs pinOfFeature), every point layer map.config.json lists; `.area`: the words of the
 *  names its area goes by (siteArea). */
function sitePins(site, cfg, own = null) {
  const pins = [];
  const expected = expectOf(cfg);
  const names = expected.map((e) => e.name);
  let stops = 0;
  for (const l of Array.isArray(cfg?.layers) ? cfg.layers : []) {
    if (typeof l?.id !== 'string' || (l.type && l.type !== 'points')) continue;
    let fc = null;
    try { fc = loadLayer({ ...site, config: cfg }, l.id, { required: false }); } catch { /* validate names a layer it cannot read */ }
    // a trip's stops, as uw validate finds them: a place with nights, never a place to stay (a hotel's name names no area)
    const staysHere = fc?.uw?.cmd === 'stay' || isLodging({ layer: l.id });
    for (const f of fc?.features || []) {
      if (f?.geometry?.type !== 'Point') continue;
      const pr = f.properties || {};
      if (!staysHere && Number.isInteger(pr.nights) && pr.nights >= 1 && pr.id != null) { stops += 1; names.push(pr.name, pr.name_en, pr.looked_up_as); }
      const pin = pinOfFeature(l.id, f);
      // the pin this run was to replace (its own id): that place only by what it is, its own names and object, never by
      // its id or the name it was once looked up by (a wrong match, picked for that name, looked up again)
      if (own?.id && l.id === own.layer && String(pin.id) === String(own.id)) Object.assign(pin, { byId: false, names: pin.names.filter((n) => n !== f.properties?.looked_up_as) });
      pins.push(pin);
    }
  }
  return Object.assign(pins, { area: areaWords(names.filter(Boolean), [], { stops: Math.max(expected.length, stops) }) });
}
/** The words of the names the map's area goes by: the trip's stops (a place with nights, the stops "expect" names), so
 *  a place looked up with its city after its name ("St Michael's Bridge Ghent") is the place of that name, and on a
 *  trip of two stops or more one city's place is never another's of that name (missing.mjs placeIn). */
const siteArea = (site, cfg) => sitePins(site, cfg).area;
/** List a place as "not found yet", unless a pin is that place already (missing.mjs: under its name, or the place its
 *  lookup found under another name, `place`): the page would say "Not found yet" beside its pin. The pin under this
 *  run's own id, which the run was to replace, counts only by what it is (sitePins): a wrong match looked up again
 *  under its id is never "that place". A place has one entry: one looked up again under another id or wording ("St
 *  Michael's Bridge Ghent" after "St Michael's Bridge, Ghent": the same name once the city it ends on is set aside,
 *  missing.mjs sameMissing) is kept on the first one's entry ("also"), whose pin takes it off.
 *  A run that was to replace the pin under its id (`replacing`) and found nothing lists the place by its name only:
 *  that pin stays (`stays`), and an entry under its id would be on the map, as uw validate judges it.
 *  → { listed, pinned, with, stays } (`pinned`: that pin, { layer, id, names }; `with`: the entry's name it was listed
 *  with; `stays`: the pin under the run's id that stays as it was, { layer, id, names }). */
export function noteMissing(site, { layer, id, name, query, tried = [], place = null, replacing = false }) {
  if (!site?.config || !name) return { listed: false, pinned: null, with: null };
  try {
    return withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    const list = Array.isArray(cfg.missing) ? cfg.missing : [];
    const key = missKey(name);
    const pins = sitePins(site, cfg, replacing ? { layer, id } : null);
    // a run that was to replace the pin under its id found nothing to put there: that pin stays as it was, so the place
    // is listed by its name, never under that id (an entry under a pinned id is on the map, as uw validate judges it:
    // the entry stood beside the pin, and the check failed it, telling the turn to take the entry off)
    const stays = replacing && id ? pins.find((p) => p.layer === layer && String(p.id) === String(id)) || null : null;
    if (stays) id = null;
    const entry = { name, layer, ...(id ? { id } : {}), ...(query && query !== name ? { query } : {}),
      tried: [...new Set(tried)].length ? [...new Set(tried)] : [searchLabel()], at: new Date().toISOString().slice(0, 10), ...(place ? { place } : {}) };
    const k = list.findIndex((m) => m && ((id && m.id === id && m.layer === layer) || missKey(m.name) === key));
    // the same place's entry under another id or wording: this lookup is kept on it ("also", once), never listed a
    // second time
    const same = k < 0 ? list.findIndex((m) => m && sameMissing(m, entry, pins.area)) : -1;
    const lookup = { ...(id ? { id } : {}), name, ...(entry.query ? { query: entry.query } : {}), layer };
    const known = same >= 0 && Array.isArray(list[same].also) ? list[same].also.filter((a) => a && !(String(a.id ?? '') === String(id ?? '') && missKey(a.name) === key)) : [];
    const also = same >= 0 ? [...known, lookup] : null;
    const merged = k >= 0 ? { ...list[k], ...entry } : same >= 0 ? { ...list[same], also } : entry;
    const pinned = missingPinned(merged, pins, pins.area);
    const at = k >= 0 ? k : same;
    if (pinned) {
      // on the map already: an older entry for it goes too
      if (at < 0) return { listed: false, pinned, with: null };
      list.splice(at, 1);
      if (list.length) cfg.missing = list; else delete cfg.missing;
    } else {
      if (at >= 0) list[at] = { ...merged, tried: [...new Set([...(list[at].tried || []), ...entry.tried])] }; else list.push(entry);
      cfg.missing = list;
    }
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    return { listed: !pinned, pinned, with: same >= 0 && !pinned ? list[same].name : null, stays: !pinned ? stays : null };
    });
  } catch { /* the refusal itself matters more */ return { listed: false, pinned: null, with: null }; }
}
/** Take a place off the "Not found yet" list (an alternative the plan does not need, e.g. a researched hotel at a
 *  stop that already has its base). */
export function forgetMissing(site, entry) {
  try {
    return withSiteLock(site, () => {
      const cfg = readJSON(site.cfgPath);
      if (!clearMissing(cfg, { layer: entry.layer, id: entry.id ?? null, names: [entry.name].filter(Boolean), query: entry.query || null })) return false;
      if (!cfg.missing.length) delete cfg.missing;
      writeJSON(site.cfgPath, cfg, { pretty: true });
      site.config = cfg;
      return true;
    });
  } catch { return false; }
}

// Parts of a place (entrances, platforms, stops): never the thing a person asked for by name.
const PART_TYPE = /^(railway=(subway_entrance|entrance|train_station_entrance|platform|stop|stop_position|halt_position)|public_transport=(platform|stop_position|stop_area|entrance)|highway=(bus_stop|platform)|entrance=)/;
// What only stands in a place and takes its name (a playground in a park or on a square, a car park under it, a toilet
// block): never the place a query names unless the query or --kind names that kind, or the query is its own name and
// nothing else fits ("Metropol Parasol" took the playground "Parque Metropol Parasol" over the Setas themselves).
// --pick still takes one. A visitor centre or a tourist office (tourism=information) is a place people go to: not one
const STANDS_IN = /^(leisure=(playground|picnic_table|fitness_station|outdoor_seating|bleachers)|amenity=(parking|parking_space|parking_entrance|bicycle_parking|motorcycle_parking|bench|toilets|drinking_water|waste_basket|waste_disposal|recycling|telephone|post_box|vending_machine|charging_station|atm|lounger))$/;
/** Does the query or --kind name the kind a candidate is ("Retiro playground", --kind parking)? Each word of its
 *  OpenStreetMap value ("bicycle_parking": bicycle, parking), a plural's s aside. */
function kindAsked(c, ...said) {
  const text = ` ${said.filter(Boolean).join(' ').toLowerCase().replace(/[_-]+/g, ' ')} `;
  const words = String(c.type || '').split('=')[1]?.split('_').filter(Boolean) || [];
  return words.length > 0 && words.every((w) => text.includes(w.replace(/s$/, '')));
}
// A business named after a place (a hotel, a restaurant or a café, a shop) is not that place: the bazaar "Castle Garden
// Bazaar" found the "Hotel Castle Garden", the quay "Graslei" the restaurant "De Graslei" on it, a market hall a shop
// that takes its name. Judged for a sight's lookup only (SIGHT_LAYER): there one is the place only when the lookup
// asks for its kind (--kind or its query says so: a place to stay, food or drink, a shop), its own name adds no word
// to the query's (nameWithinQuery), or a shop's adds only its branch (branchOfQuery).
const BUSINESS = [
  { kind: 'lodging', type: /^(tourism=(hotel|hostel|guest_house|motel|apartment|chalet)|building=hotel)$/ },
  { kind: 'food', type: /^amenity=(restaurant|cafe|fast_food|bar|pub|biergarten|food_court|ice_cream)$/ },
  { kind: 'shop', type: /^shop=/ },
];
// (words, not parts of words: "Café Sperl" names a café, "Barcelona" no bar)
const FOOD_ASKED = /(?<![\p{L}\p{N}])(restaurants?|caf[eé]s?|coffee|bars?|pubs?|bistros?|brasseries?|trattorias?|osterias?|pizzerias?|taverns?|tavernas?|eater(y|ies)|diners?|food|bakery|bakeries|ice ?cream|gelaterias?|beer ?gardens?|biergartens?)(?![\p{L}\p{N}])|餐廳|咖啡|食堂|レストラン|カフェ/iu;
const SHOP_ASKED = /(?<![\p{L}\p{N}])(shops?|stores?|boutiques?|outlets?)(?![\p{L}\p{N}])|商店/iu;
// the layers places to see go on (reference/itinerary.md: sights, day trips): a lookup there is a sight's, and only
// there is a business named after the place refused. Any other layer (a listing's venues on "events", a list of bars,
// places to stay) takes the business its query names, as it always did
const SIGHT_LAYER = /^(sights?|daytrips?|day-trips?|attractions?|landmarks?)$/i;
const BUSINESS_WORD = { hotel: 'a hotel', hostel: 'a hostel', guest_house: 'a guest house', motel: 'a motel', apartment: 'a holiday flat', chalet: 'a chalet',
  restaurant: 'a restaurant', cafe: 'a café', fast_food: 'a fast-food place', bar: 'a bar', pub: 'a pub', biergarten: 'a beer garden', food_court: 'a food court',
  ice_cream: 'an ice-cream shop' };
/** Is one of a candidate's own names made only of the query's words (accents, case and punctuation aside, and the
 *  area's names it adds)? "<Name>" for "The <Name>, <City>" is; "De <Name>" for "<Name> <City>", or "Hotel Castle
 *  Garden" for "Castle Garden Bazaar", adds a word: a business so named is named after the place. Pure. */
function nameWithinQuery(query, names, area = []) {
  const around = new Set(area.flatMap(bizWords));
  const asked = new Set(bizWords(query));
  return names.filter(Boolean).some((n) => { const own = bizWords(n).filter((w) => !around.has(w)); return own.length > 0 && own.every((w) => asked.has(w)); });
}
const bizWords = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
// words that say what kind of business a name is, beyond the place's own name ("\u2026 Gift Shop", "\u2026 Souvenirs")
const GIFT_WORDS = /(?<![\p{L}\p{N}])(gifts?|souvenirs?|merch(andise)?)(?![\p{L}\p{N}])/iu;
/** Is one of a shop's own names the query's name and then its branch: the query's own words (before a comma, the
 *  area's names aside) in order, then words that name no kind of place to stay, eat or shop ("Hamleys Regent Street"
 *  for "Hamleys, London"; a shop's branch "<Name> <street>")? A store asked for as a sight by its own name is that
 *  store; "Serralves Gift Shop" is named after the museum, and a place to stay or eat is never the sight by its first
 *  words ("Acropolis View" is a hotel). Pure. */
function branchOfQuery(query, names, area = []) {
  const around = new Set(area.flatMap(bizWords));
  const asked = bizWords(queryLabel(query)).filter((w) => !around.has(w));
  if (!asked.length) return false;
  return names.filter(Boolean).some((n) => {
    const own = bizWords(n).filter((w) => !around.has(w));
    if (own.length <= asked.length || asked.some((w, i) => own[i] !== w)) return false;
    const added = own.slice(asked.length).join(' ');
    return !LODGING_RE.test(added) && !FOOD_ASKED.test(added) && !SHOP_ASKED.test(added) && !GIFT_WORDS.test(added);
  });
}
// A board or a sign that carries a place's name is not that place: an information board by it (`information=board`),
// a guidepost to it, a map board, an advertising board, a traffic sign. A visitor centre or a tourist office is a place
// people go to (information=office, visitor_centre; tourism=information with no more said): never one of these.
// Judged for a sight's lookup only (SIGHT_LAYER), as a business named after the place is
const SIGN_TYPE = /^(information=(?!(?:office|visitor_centre|ranger_station)$)|advertising=|traffic_sign=)/;
// A street (a road, a lane, a path) is never a venue, a sight or a place to stay that a lookup names by its name: one
// that only carries a word of it is another place's name ("Brentford Street" for a match against Brentford). A
// pedestrian street or square stays a place one can be asked for (a square is often mapped as one)
const STREET_TYPE = /^highway=(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|track|path|footway|cycleway|bridleway|steps|corridor|busway)(_link)?$/;
// a lookup that asks for a street: its words, in the languages the map's cities use most, or --kind street
const STREET_ASKED = /(?<![\p{L}\p{N}])(streets?|roads?|avenues?|lanes?|boulevards?|alleys?|drives?|calle|carrer|rua|rue|via|viale|corso|strasse|straße|gasse|weg|ulica|utca|katu|gatan|gata|vej|straat|laan)(?![\p{L}\p{N}])/iu;
// A query that is a street address (a house number in it: "Damrak 1", "延平北路三段 4號"): what is found there is a
// building or the street, never a place by its name
const ADDRESS_QUERY = /\d+\s*(號|号|番地?)|\bno\.?\s*\d+|^\s*\d+[A-Za-z]?\s+\S+|\S+\s+\d+[A-Za-z]?\s*(,|$)/i;
const SIGN_WORD = { board: 'an information board', guidepost: 'a guidepost', map: 'a map board', terminal: 'an information terminal' };
/** What a refusal calls a board or a sign. */
const signWord = (c) => (/^advertising=/.test(String(c?.type || '')) ? 'an advertising board' : /^information=/.test(String(c?.type || '')) ? SIGN_WORD[String(c.type).split('=')[1]] || 'a sign' : 'a sign');
/** The kind of business a candidate is (lodging, food, shop), or null. */
const businessOf = (c) => BUSINESS.find((b) => b.type.test(String(c?.type || '')))?.kind || null;
/** Is a candidate of a kind that takes a place's name rather than being that place: a business, an office or another
 *  organisation (an office, a club, a craft, a practice), a stop or a station, or a spot that stands in a place? */
const namedAfterKind = (c) => { const t = String(c?.type || ''); return !!businessOf(c) || /^(office|club|craft|healthcare)=/.test(t) || TRANSIT_TYPE.test(t) || STANDS_IN.test(t); };
/** What a refusal calls it: "a hotel", "a restaurant", "a shop". */
const businessWord = (c) => (STREET_TYPE.test(String(c?.type || '')) ? 'a street' : BUSINESS_WORD[String(c?.type || '').split('=')[1]] || (/^shop=/.test(String(c?.type || '')) ? 'a shop' : 'a business'));
/** Does a sight's lookup ask for a business of this kind (businessOf's): its --kind (or the props' kind) or its query
 *  names it ("Hotel …", "Café …", --kind restaurant). */
function businessAsked(kind, { query = '', kind: given = null } = {}) {
  const k = String(given ?? '');
  if (kind === 'lodging') return isLodging({ query, kind: given });
  if (kind === 'food') return FOOD_ASKED.test(query) || FOOD_ASKED.test(k) || /^(restaurant|cafe|fast_food|bar|pub|biergarten|food)/i.test(k);
  return SHOP_ASKED.test(query) || SHOP_ASKED.test(k) || /^(shop|store|boutique)/i.test(k);
}
const TRANSPORT_TYPE = /^(highway=bus_stop|amenity=(bus_station|taxi|ferry_terminal)|public_transport=|railway=(halt|stop|tram_stop))/;
// Every transit object (stations included): named after the place it serves, never that place.
const TRANSIT_TYPE = /^(railway=(station|halt|stop|tram_stop|subway_entrance|platform)|public_transport=|highway=(bus_stop|platform)|amenity=(bus_station|ferry_terminal|taxi)|aeroway=)/;
// A station (or its building): what a query for the place it is named after can find instead of that place.
const STATION_TYPE = /^(railway=(station|halt)|public_transport=station|building=(train_station|transportation))$/;
// Where the place a station is named after is looked for: squares (often mapped as a pedestrian area), the quarter,
// a park or a sight, within NAMED_PLACE_M of the station.
const NAMED_PLACE_TAGS = ['place:square', 'highway:pedestrian', 'place:quarter', 'place:neighbourhood', 'leisure:park', 'tourism:attraction'];
// only those (a fallback provider's answer to a filtered search can be any place: a city's own point)
const NAMED_PLACE_TYPE = new RegExp(`^(${NAMED_PLACE_TAGS.map((t) => t.replace(':', '=')).join('|')})$`);
const NAMED_PLACE_M = 600;
// the keys OpenStreetMap keeps a place's names under: its name, other, old, official and short names, in any language
const NAME_KEY = /^(name|alt_name|old_name|official_name|short_name|loc_name|int_name|nat_name|reg_name)(:[a-z]{2,3}(-[A-Za-z]+)?)?$/;
/** Every name OpenStreetMap has for these objects (osm-w123 ids), by id: one Overpass lookup. */
async function osmNames(ids) {
  const refs = ids.map((id) => String(id).match(/^osm-([nwr])(\d+)$/i)).filter(Boolean)
    .map((m) => `${{ n: 'node', w: 'way', r: 'relation' }[m[1].toLowerCase()]}(${m[2]});`);
  const names = new Map();
  if (!refs.length) return names;
  const data = await overpass(`[out:json][timeout:25];\n(${refs.join('')});\nout tags;`, { timeoutS: 25, quick: true });
  for (const el of data.elements || []) {
    const t = el.tags || {};
    names.set(`osm-${String(el.type)[0]}${el.id}`, Object.keys(t).filter((k) => NAME_KEY.test(k)).flatMap((k) => String(t[k]).split(';')).map((x) => x.trim()).filter(Boolean));
  }
  return names;
}
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
/** add-point by an OpenStreetMap object under the id and name a place was looked up by, which clears its "Not found
 *  yet" entry (clearMissing), whatever OpenStreetMap calls it */
function pinAs(args, layer) {
  const name = args.name || queryLabel(args.query || '');
  return `uw add-point ${args._[0]} --layer ${layer} --osm <its osm id>${args.id ? ` --id ${args.id}` : ''} --name "${String(name).replace(/(["\\$`])/g, '\\$1')}"`;
}
function altLines(alt, args, layer) {
  if (!alt.length) return [];
  return ['OpenStreetMap has these objects nearby with that name as an old, alternative or English name (renamed or rebranded?):',
    ...alt.map((a) => `  ${a.osm_id}: ${a.name} [${a.type}] (${a.matched}) ${a.address ? '— ' + a.address : ''} ${a.distance_km != null ? `(${a.distance_km} km away)` : ''}`),
    `  If one is the place, add it exactly: ${pinAs(args, layer)} (and tell the user about its new name).`];
}
