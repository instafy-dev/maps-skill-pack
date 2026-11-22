// A trip's stops: one stop per city. A map of two cities held one of them twice in its stops layer, as its station
// (`uw station`, a slow lookup) and as the city itself (pinned by hand after it), each with the stop's nights: the map
// listed three stops for two, and the check asked for places to stay at the one no day used. `uw add-point` and `uw
// station` keep one: the city pinned beside its station is refused, naming the stop that is there; a station found for
// a city pinned as itself takes that pin's place, under its id. Pure: no network, no files.
import { haversine } from './util.mjs';

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const CITY_KIND = /^(city|town|village|hamlet|municipality|suburb|borough|island)$/i;
const pointOf = (f) => (f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null);
/** A stop that is the city itself: a place by its kind, or pinned where no station was found ("no_station"). */
export const isCityStop = (p) => p?.no_station === true || CITY_KIND.test(String(p?.kind ?? ''));
/** A stop that is a city's railway station as `uw station` writes it (a high-speed station out of town is a stop of
 *  its own, passed through: never the city's one stop). */
const isCityStation = (p) => !isCityStop(p) && typeof p?.station_of === 'string' && p.station_of.trim() !== '' && p.station_kind !== 'hsr';
/** The names a stop's city goes by: a station's "station_of"; a city's own names and what it was looked up by. */
const cityNames = (p) => (isCityStop(p) ? [p.name, p.name_en, p.osm_name_en, p.station_of, p.looked_up_as] : [p.station_of]).map(fold).filter(Boolean);
/** The city's own point as a stop knows it: a city's pin; a station's "centre_lnglat" (the centre `uw station` found). */
const centreOf = (f) => (isCityStop(f?.properties) ? pointOf(f) : Array.isArray(f?.properties?.centre_lnglat) ? f.properties.centre_lnglat : null);
/** Within this distance two centres are one city's (the same place search answer, or its point a few streets off). */
const SAME_CENTRE_M = 2000;
/** A station is never this far from its city's pin, nor one city pinned twice (uw station looks within 20 km). */
const FAR_APART_M = 40000;

/** Are these two stops (features of one layer) one city's: the city itself and its station, or the city pinned twice?
 *  By name (a station's "station_of" is one of the city's names, its English one too: "Padua" for "Padova"), or by
 *  the city's own point (the centre `uw station` looked the station up around is the city's pin). Two stations are two
 *  stops, whatever their city (a station and a high-speed station out of town; a night by the airport). Only stops:
 *  one of them is a station of `uw station`, or both carry nights. */
export function sameCityStop(a, b) {
  const pa = a?.properties || {}, pb = b?.properties || {};
  const cityA = isCityStop(pa), cityB = isCityStop(pb);
  if (!cityA && !cityB) return false;
  if (!((cityA || isCityStation(pa)) && (cityB || isCityStation(pb)))) return false;
  const stops = isCityStation(pa) || isCityStation(pb) || (Number.isInteger(pa.nights) && Number.isInteger(pb.nights));
  if (!stops) return false;
  // (two towns of one name far apart are two stops)
  const at = pointOf(a), bt = pointOf(b);
  if (at && bt && haversine(at, bt) > FAR_APART_M) return false;
  const na = cityNames(pa), nb = cityNames(pb);
  if (na.some((n) => nb.includes(n))) return true;
  const ca = centreOf(a), cb = centreOf(b);
  return !!ca && !!cb && haversine(ca, cb) <= SAME_CENTRE_M;
}

/** The stop in `features` that is the city of `feature` under another id (sameCityStop), or null. */
export function cityStopTwin(features, feature) {
  const id = String(feature?.properties?.id ?? '');
  return (Array.isArray(features) ? features : []).find((f) => f !== feature && String(f?.properties?.id ?? '') !== id && sameCityStop(f, feature)) || null;
}
