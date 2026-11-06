// A trip's places to stay. Every stop with nights gets them from `uw stay` (reference/itinerary.md step 3, "One base"
// step 2); an area pinned as the place to stay stands in only where uw stay found none. A Seville map once had only its
// area pinned, with a note no page had said, before the turn read any page: uw stay never ran, and `uw validate` asked
// for nothing, as the map had no "expect". `uw stay` now keeps where it looked for each stop, found or not, in the
// site's state folder (lib/state-dir.mjs: outside the space's files), so `uw validate` can tell an area uw stay found
// nothing around from an area pinned instead of looking.
import fs from 'node:fs';
import path from 'node:path';
import { stateDirOf, stateDirsOf } from './state-dir.mjs';
import { isLodging } from './registry-geo.mjs';

const FILE = 'stays-looked-up.json';
/** uw stay's widest radius (m): none found there is as far as it looks. */
export const STAY_RADIUS_MAX = 3000;

// a pin that is an area, not a place to stay: the "--kind area" recommendation, or a neighbourhood, district or town
// pinned in a stays layer
const AREA_KINDS = new Set(['area', 'neighbourhood', 'neighborhood', 'suburb', 'quarter', 'district', 'borough', 'city_block',
  'locality', 'city', 'town', 'village', 'hamlet', 'municipality', 'county', 'region', 'island']);
/** Is this feature an area (pinned as the place to stay), not a place to stay? */
export const isAreaPin = (props) => AREA_KINDS.has(String(props?.kind ?? '').toLowerCase());

// where a traveller sleeps: lodging (a hotel, hostel, guest house, apartment …), a hut or a campsite
const sleepsIn = (kind) => isLodging({ kind }) || /(^|_)(hut|camp_site|caravan_site|shelter)$/.test(String(kind ?? '').toLowerCase());

/** A place to stay among a trip's stays: lodging by its kind, a pick of uw stay (it keeps where it looked: near_ref) or a
 *  hotel a research team named. Anything else pinned there (an area, a square, a landmark) only says where to stay. */
export const isPlaceToStay = (props) => sleepsIn(props?.kind) || props?.near_ref != null || props?.researched === true;

/** A stop that is itself where the traveller sleeps (a hut, a campsite, a hotel asked for as a stop): no stays of its own. */
export const stopIsAStay = (props) => sleepsIn(props?.kind);

/** Did uw stay look as far as it goes: it found some, the search was busy (exit 4), or none within its widest radius
 *  (a first run looks 800 m around; with none it prints the same lookup, wider)? */
export const lookedAsFarAsItGoes = (rec) => !!rec && (rec.status !== 'none' || !(Number(rec.radius) < STAY_RADIUS_MAX));

/** Where uw stay looked for places to stay on the site in `dir`: { <stop id>: { at, status: found | none | unavailable,
 *  found, radius, near, widen: the same lookup wider, after none } }. No network. */
export function staysLookedUp(dir, env = process.env) {
  const out = {};
  for (const d of stateDirsOf(dir, env)) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(d, FILE), 'utf8')); } catch { continue; }
    if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Keep that uw stay looked for places to stay for `stop`, whatever it found. Call holding the site's write lock. */
export function noteStaysLookedUp(dir, stop, entry, env = process.env) {
  const file = path.join(stateDirOf(dir, env), FILE);
  let all = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) all = j; } catch { /* the first */ }
  all[String(stop)] = { at: new Date().toISOString(), ...entry };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, file);
  } catch { /* state is best effort: validate then asks for the lookup again */ }
}
