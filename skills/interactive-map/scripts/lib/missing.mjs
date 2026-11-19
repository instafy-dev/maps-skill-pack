// map.config.json "missing": the places asked for that are not on the map yet (the page's "Not found yet" line). Which
// pin is the place an entry names: `uw add-point` takes an entry off when it pins that place, and lists none for a place
// already pinned; `uw validate` fails an entry that stands beside its own pin. A trip's map once read "Not found yet:
// Main Market Square" over its own pin for the square: the lookup by that name was refused (its best match, "Rynek
// Główny / Main Square", is named only with words that name no place on their own), and the turn then pinned that very
// square by its local name, under another id. Pure: no network, no files.
import { haversine } from './util.mjs';
import { queryLabel } from './registry-geo.mjs';
import { SAME_PLACE_M } from './site.mjs';

/** A name or a query as the list compares them: case, spaces and commas aside. */
export const missKey = (s) => String(s || '').toLowerCase().replace(/[\s,，、]+/g, ' ').trim();
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const wordsOf = (s) => fold(s).match(/[\p{L}\p{N}]+/gu) || [];

// The kinds of place a pin can stand inside: a square or a pedestrian street, a park or a garden, a quarter, a natural
// area. Never a building (a hotel, a museum): the best match a lookup refused there is another place
const AREA_TYPE = /^(place=(square|quarter|neighbourhood|suburb|locality|borough|city_block|island|islet)|highway=(pedestrian|living_street)|area:highway=|leisure=(park|garden|nature_reserve|common|recreation_ground)|landuse=(recreation_ground|village_green|cemetery|forest|meadow|grass)|boundary=(national_park|protected_area)|natural=|tourism=(zoo|theme_park))/;

/** The place a "not found" entry names when its lookup found it under another name, kept on the entry: the best match
 *  in range of a refusal for the name (`c`, a candidate), when it is a place a pin can stand inside (a square, a park,
 *  a quarter) and one of its names is made only of words the entry's name or query has, two or more ("Main Square"
 *  for "Main Market Square, Kraków": neither of its words names a place, so the lookup refused it). Its OpenStreetMap
 *  object, its names, its point and its outline (`bbox`: [w, s, e, n], when the search gave one) → or null. */
export function missedPlace(c, { name, query } = {}) {
  if (!c || !Array.isArray(c.coord) || !AREA_TYPE.test(String(c.type || ''))) return null;
  const asked = new Set([...wordsOf(name), ...wordsOf(queryLabel(query || ''))]);
  const names = [...new Set([c.name, c.name_en].filter((n) => typeof n === 'string' && n.trim()))];
  if (!names.some((n) => { const w = wordsOf(n); return w.length >= 2 && w.every((x) => asked.has(x)); })) return null;
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

/** Is this pin (pinOfFeature) the place a "not found" entry names? Its id, in the entry's layer; one of its names, or
 *  the query it was looked up by, is the entry's name or query; or it is the place the entry's lookup found under
 *  another name (the entry's `place`, missedPlace): that OpenStreetMap object, or a pin named as that place inside its
 *  outline or within 150 m of it (another object of the same square). */
export function pinNamesMissing(m, pin) {
  if (!m || typeof m !== 'object' || !pin) return false;
  if (m.id && pin.id != null && String(m.id) === String(pin.id) && (m.layer || pin.layer) === pin.layer) return true;
  const keys = new Set([...(pin.names || []), pin.query ? queryLabel(pin.query) : null, pin.query].map(missKey).filter(Boolean));
  if (keys.has(missKey(m.name)) || (m.query && keys.has(missKey(m.query)))) return true;
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

/** The first of these pins that is the place an entry names, or null. */
export function missingPinned(m, pins) {
  return pins.find((pin) => pinNamesMissing(m, pin)) || null;
}

/** Take off map.config.json "missing" every entry this pin is (pinNamesMissing). → how many went. */
export function clearMissing(cfg, pin) {
  if (!Array.isArray(cfg?.missing)) return 0;
  const before = cfg.missing.length;
  cfg.missing = cfg.missing.filter((m) => !pinNamesMissing(m, pin));
  return before - cfg.missing.length;
}
