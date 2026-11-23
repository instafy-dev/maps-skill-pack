// map.config.json "asked": the places the person's message named, as `uw new --asked` kept them ({ name, at }), so a
// place they named is never lost on the way to the map. A trip's map lost the castle its message named: the turn
// joined the castle's pin to a refused page with `&&`, the pin never ran, and nothing listed the castle as not found;
// its one mark for a place the person named went on a square the turn had chosen for the old town. `uw validate`
// fails while a place on the list is neither pinned nor listed "Not found yet", naming the lookup to run, and a mark
// "asked" goes only on a place of the list (cmd-geocode.mjs, cmd-set.mjs). Pure but for reading the site's layers.
import { queryLabel } from './registry-geo.mjs';
import { sameNamed } from './names.mjs';
import { UsageError } from './util.mjs';

/** "Wawel Castle, Kazimierz Synagogue" (or a list) → [{ name }]: each place once, in the order given. Commas,
 *  semicolons and new lines separate them; a name is at most 80 characters. */
export function parseAsked(raw) {
  if (raw == null || raw === '') return [];
  const list = (Array.isArray(raw) ? raw : String(raw).split(/[,;\n]/)).map((x) => String(x ?? '').trim()).filter(Boolean);
  const out = [];
  for (const name of list) {
    if (name.length > 80) throw new UsageError(`--asked: "${name.slice(0, 40)}…" is not a place's name (at most 80 characters; separate places with commas)`);
    if (!out.some((o) => o.name.toLowerCase() === name.toLowerCase())) out.push({ name });
  }
  return out;
}

/** The places the person named, as the map keeps them: [{ name, at }] (entries of another shape are not read). */
export const askedOf = (cfg) => (Array.isArray(cfg?.asked) ? cfg.asked : []).filter((a) => a && typeof a === 'object' && typeof a.name === 'string' && a.name.trim());

/** The words of the names the map's area goes by (its stops, the stops it expects), so a name that ends on its city
 *  ("Wawel Castle Kraków") is the place of that name. */
export function askedArea(cfg, more = []) {
  return [...(Array.isArray(cfg?.expect) ? cfg.expect.map((e) => e?.name) : []), ...more].filter((x) => typeof x === 'string' && x.trim());
}

/** The entry of the list a place is, by any of its names (names.mjs sameNamed: either holds the other), or null. */
export function askedEntry(list, names, area = []) {
  const own = names.filter((n) => typeof n === 'string' && n.trim());
  return list.find((a) => own.some((n) => sameNamed(a.name, n, area))) || null;
}

/** The names a pin goes by: its name, English names, the name it was looked up by. */
export const pinNames = (p) => [p?.name, p?.name_en, p?.osm_name_en, p?.looked_up_as].filter((n) => typeof n === 'string' && n.trim());

/** The command that says a pin is a place the person named under another name (its local name): their name for it
 *  as the name it was looked up by, with the mark (uw set judges the mark with it). Only for the place they named. */
export const askedNameFix = (dir, ref, name = '<the name they gave it>') =>
  `uw set ${dir} ${ref} --props-file - with {"looked_up_as":"${String(name).replace(/(["\\])/g, '\\$1')}","asked":true}`;

/** Was the list written in this turn (`turnStartedMs`; no clock: yes)? Then a mark goes only on a place it names; in a
 *  later turn a place the person names then joins it. The pack's own clock starts with the command after `uw new` (the
 *  site it times is made by it): a list written seconds before is this turn's. */
export function namedThisTurn(list, turnStartedMs = null) {
  if (turnStartedMs == null) return true;
  return list.some((a) => { const t = Date.parse(a.at ?? ''); return !Number.isFinite(t) || t >= turnStartedMs - SAME_TURN_MS; });
}
const SAME_TURN_MS = 10_000;

/** The places of the list the map has neither pinned (a point of any layer by one of its names) nor listed as not found
 *  yet (map.config.json "missing": an entry by its name or the query it was looked up by, or a later lookup of it,
 *  "also"). `featuresByLayer`: Map(layer → features). → [{ name }] */
export function askedLeftOut(cfg, featuresByLayer, area = askedArea(cfg)) {
  const list = askedOf(cfg);
  if (!list.length) return [];
  const pins = [...featuresByLayer.values()].flat().filter((f) => f?.geometry?.type === 'Point').map((f) => pinNames(f.properties));
  const missing = (Array.isArray(cfg?.missing) ? cfg.missing : []).filter((m) => m && typeof m === 'object')
    .flatMap((m) => [m, ...(Array.isArray(m.also) ? m.also.filter((a) => a && typeof a === 'object') : [])])
    .map((m) => [m.name, m.query ? queryLabel(m.query) : null]);
  const has = (a, sets) => sets.some((names) => askedEntry([a], names, area));
  return list.filter((a) => !has(a, pins) && !has(a, missing));
}
