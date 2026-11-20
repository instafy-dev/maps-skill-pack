// map.config.json "missing": the places asked for that are not on the map yet (the page's "Not found yet" line). Which
// pin is the place an entry names: `uw add-point` takes an entry off when it pins that place, and lists none for a place
// already pinned; `uw validate` fails an entry that stands beside its own pin. A trip's map once read "Not found yet:
// Main Market Square" over its own pin for the square: the lookup by that name was refused (its best match, "Rynek
// Główny / Main Square", is named only with words that name no place on their own), and the turn then pinned that very
// square by its local name, under another id. A place has one entry: a trip's map listed one bridge twice, looked up
// as "St Michael's Bridge, Ghent" and again as "St Michael's Bridge Ghent" under another id. Pure: no network, no files.
import { haversine } from './util.mjs';
import { queryLabel } from './registry-geo.mjs';
import { SAME_PLACE_M } from './site.mjs';

/** A name or a query as the list compares them: case, spaces and commas aside. */
export const missKey = (s) => String(s || '').toLowerCase().replace(/[\s,，、]+/g, ' ').trim();
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const wordsOf = (s) => fold(s).match(/[\p{L}\p{N}]+/gu) || [];

/** The words of the names the map's area goes by, for placeLabel: each of `names` (the trip's stops, the stops the map
 *  expects) and what follows the first comma of each of `queries` ("St Michael's Bridge, Ghent": Ghent). → a Set. */
export function areaWords(names = [], queries = []) {
  const set = new Set();
  for (const n of names) for (const w of wordsOf(n)) set.add(w);
  for (const q of queries) for (const w of wordsOf(String(q || '').split(/[,，、]/).slice(1).join(' '))) set.add(w);
  return set;
}
/** A name or a query as the place it names: the part before a comma, folded, without the area's names it ends on ("St
 *  Michael's Bridge Ghent" on a map of Ghent is "st michael s bridge"); never down to nothing, and never a name the
 *  area's name starts ("Ghent Altarpiece" keeps its "ghent"). `area`: areaWords'. */
export function placeLabel(s, area = new Set()) {
  const w = wordsOf(queryLabel(String(s || '')));
  while (w.length > 1 && area.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}
/** The lookups an entry stands for: its own (name, id, query) and those that named the same place later ("also"). */
const lookupsOf = (m) => [m, ...(Array.isArray(m?.also) ? m.also.filter((a) => a && typeof a === 'object') : [])];
/** The area words for comparing an entry with another or with a pin: `area` and what follows a comma in their queries. */
const areaFor = (area, ...items) => areaWords([...(area || [])], items.flatMap((x) => lookupsOf(x).map((a) => a?.query)));
/** Do two "not found" entries name one place: a name or query of one is a name or query of the other, once the area's
 *  names either ends on are set aside (placeLabel). `area`: areaWords' (the trip's stops). */
export function sameMissing(a, b, area = new Set()) {
  if (!a || !b) return false;
  const all = areaFor(area, a, b);
  const labels = (m) => new Set(lookupsOf(m).flatMap((x) => [x.name, x.query]).filter(Boolean).map((t) => placeLabel(t, all)).filter(Boolean));
  const theirs = labels(a);
  return [...labels(b)].some((l) => theirs.has(l));
}

// The kinds of place a pin can stand inside: a square or a pedestrian street, a park or a garden, a quarter, a natural
// area. Never a building (a hotel, a museum): the best match a lookup refused there is another place
const AREA_TYPE = /^(place=(square|quarter|neighbourhood|suburb|locality|borough|city_block|island|islet)|highway=(pedestrian|living_street)|area:highway=|leisure=(park|garden|nature_reserve|common|recreation_ground)|landuse=(recreation_ground|village_green|cemetery|forest|meadow|grass)|boundary=(national_park|protected_area)|natural=|tourism=(zoo|theme_park))/;

/** The place a "not found" entry names when its lookup found it under another name, kept on the entry: the best match
 *  in range of a refusal for the name (`c`, a candidate), when it is a place a pin can stand inside (a square, a park,
 *  a quarter) and one of its names is made only of words the entry's name or query has, two or more ("Main Square"
 *  for "Main Market Square, Kraków": neither of its words names a place, so the lookup refused it), and the entry
 *  names that place itself, not one inside it: the first and the last word of its name (the city it is in aside) are
 *  words of that name or the kind of place it is ("square" for a square). "City Park Lake" is a lake in the "City
 *  Park", "Old Town Hall" a hall in the "Old Town", "Fuente de la Plaza Mayor" a fountain on the "Plaza Mayor": a
 *  pin of the area is not them. Its OpenStreetMap object, its names, its point and its outline (`bbox`: [w, s, e, n],
 *  when the search gave one) → or null. */
export function missedPlace(c, { name, query } = {}) {
  if (!c || !Array.isArray(c.coord) || !AREA_TYPE.test(String(c.type || ''))) return null;
  const asked = new Set([...wordsOf(name), ...wordsOf(queryLabel(query || ''))]);
  const around = new Set([c.city, c.district, c.county, c.state, c.country].flatMap(wordsOf));
  const all = wordsOf(name || queryLabel(query || ''));
  const own = all.some((x) => !around.has(x)) ? all.filter((x) => !around.has(x)) : all;
  const kind = new Set(wordsOf(String(c.type).split('=').pop().replace(/_/g, ' ')));
  const names = [...new Set([c.name, c.name_en].filter((n) => typeof n === 'string' && n.trim()))];
  const isIt = (n) => {
    const w = wordsOf(n);
    if (w.length < 2 || !w.every((x) => asked.has(x))) return false;
    const its = (x) => w.includes(x) || kind.has(x);
    return own.length > 0 && its(own[0]) && its(own[own.length - 1]);
  };
  if (!names.some(isIt)) return null;
  const bbox = Array.isArray(c.bbox) && c.bbox.length === 4 && c.bbox.every(Number.isFinite) ? c.bbox : null;
  return { ...(c.osm_id ? { osm_id: c.osm_id } : {}), names, at: c.coord, ...(bbox ? { bbox } : {}) };
}

/** A pin as the list compares it: its layer, id, names (its name, English names, the name it was looked up by), the
 *  query it was looked up by (add-point's), its OpenStreetMap object and its point. */
export function pinOfFeature(layer, f, query = null) {
  const p = f?.properties || {};
  const coord = f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
  return { layer, id: p.id ?? null, names: [p.name, p.name_en, p.osm_name_en, p.looked_up_as].filter((n) => typeof n === 'string' && n.trim()),
    query, osm_id: p.osm_id || null, coord };
}

/** Is this pin (pinOfFeature) the place a "not found" entry names? Its id, in the entry's layer (unless the pin says
 *  `byId: false`); one of its names, or the query it was looked up by, is the entry's name or query, also once the
 *  area's names either ends on are set aside (placeLabel; `area`: areaWords' of the trip's stops); the same for each
 *  later lookup of that place the entry keeps ("also"); or it is the place the entry's lookup found under another name
 *  (the entry's `place`, missedPlace): that OpenStreetMap object, or a pin named as that place inside its outline or
 *  within 150 m of it (another object of the same square). */
export function pinNamesMissing(m, pin, area = null) {
  if (!m || typeof m !== 'object' || !pin) return false;
  const lookups = lookupsOf(m);
  if (pin.byId !== false && pin.id != null && lookups.some((a) => a.id && String(a.id) === String(pin.id) && (a.layer || m.layer || pin.layer) === pin.layer)) return true;
  const keys = new Set([...(pin.names || []), pin.query ? queryLabel(pin.query) : null, pin.query].map(missKey).filter(Boolean));
  if (lookups.some((a) => keys.has(missKey(a.name)) || (a.query && keys.has(missKey(a.query))))) return true;
  const all = areaFor(area, m, { query: pin.query });
  const labels = new Set(lookups.flatMap((a) => [a.name, a.query]).filter(Boolean).map((t) => placeLabel(t, all)).filter(Boolean));
  if ([...(pin.names || []), pin.query].filter(Boolean).some((n) => labels.has(placeLabel(n, all)))) return true;
  const p = m.place;
  if (!p || typeof p !== 'object') return false;
  if (p.osm_id && pin.osm_id && p.osm_id === pin.osm_id) return true;
  const theirs = new Set((Array.isArray(p.names) ? p.names : []).map(fold).filter(Boolean));
  if (!(pin.names || []).some((n) => theirs.has(fold(n))) || !Array.isArray(pin.coord)) return false;
  if (Array.isArray(p.bbox) && p.bbox.length === 4) {
    const [w, s, e, n] = p.bbox;
    if (pin.coord[0] >= w && pin.coord[0] <= e && pin.coord[1] >= s && pin.coord[1] <= n) return true;
  }
  return Array.isArray(p.at) && haversine(p.at, pin.coord) <= SAME_PLACE_M;
}

/** The first of these pins that is the place an entry names, or null. `area`: as pinNamesMissing's. */
export function missingPinned(m, pins, area = null) {
  return pins.find((pin) => pinNamesMissing(m, pin, area)) || null;
}

/** Take off map.config.json "missing" every entry this pin is (pinNamesMissing). → how many went. */
export function clearMissing(cfg, pin, area = null) {
  if (!Array.isArray(cfg?.missing)) return 0;
  const before = cfg.missing.length;
  cfg.missing = cfg.missing.filter((m) => !pinNamesMissing(m, pin, area));
  return before - cfg.missing.length;
}
