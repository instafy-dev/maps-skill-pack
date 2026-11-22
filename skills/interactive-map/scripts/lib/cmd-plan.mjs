// `plan`: the day-by-day "plan" block of a trip, built from what the commands already wrote (stops with nights, legs,
// stays, sights), so dates, nights and travel days add up and every item points at a real feature. A trip may have
// one stop: days in one place, each day a loop from the same base. The agent then adds one sourced line of text per
// day; it never has to type the skeleton (or a date) by hand.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, makeOut, parseList, readJSON, writeJSON, writeGeoJSON, haversine, representativePoint, clipWords, slugify, UsageError, UserError } from './util.mjs';
import { openSite, loadLayer, layerPath, checkLayerId } from './site.mjs';
import { expectOf, featureNames } from './expect.mjs';
import { isLodging } from './registry-geo.mjs';
import { stillRunning, runningList, handoffStep } from './running.mjs';
import { stateDirOf, stateDirsOf } from './state-dir.mjs';
import { REPLY_WITHIN_S } from './turn-advice.mjs';
import { notOwnPages, OWN_PAGE_WAY } from './cmd-cite.mjs';

export const help = `plan <dir> --stops <layer> --start YYYY-MM-DD [--ids taipei,hualien,…,taipei] [--nights 3,2,2,3,2,2]
     [--legs trip] [--stays stays] [--sights sights[,food,daytrips]] [--per-day 3] [--title "Plan"] [--json]
  Writes map.config.json "plan": one day per date from --start, nights per stop in travel order, a travel day per leg.
  --ids: the stops in travel order (a loop names its first stop again at the end); default: the layer's order. One
  stop is a stay in one place ("3 days in Lisbon": --ids lisbon --nights 3): its days are loops from the same base,
  no travel day, and no departure day (3 nights are 3 dated days; the traveller leaves the day after); the stop is not
  listed among the map's places (its layer gets "list": false; the Plan tab names it). A stop named
  twice in a row is one stay (its nights add up), never a travel day to itself. Two stays in a row (nights at both)
  closer than about 15 km are places in one city, not a trip: refused (plan one stop, the city; its sights are
  grouped into days by area). A place of its own (a city, town, village or island, a station or an airport, by the
  stop's "kind") is not in one city with another: two of them are a trip (not two stations of one city), and so is
  one beside another stop when the map's "expect" names both (uw new --expect "Zermatt:2,Hörnli Hut:1"). A place to
  stay (a hotel, a hostel …, or a place \`uw stay\` picked) is refused as a stop unless the map's "expect" names it:
  the city is the stop and the hotel its stay, so the days read the city's name.
  --nights: one number per --ids entry (the last stop of a loop may be 0 = fly out the day you arrive; a first stop
  with 0 nights is left the day you arrive; one stop with 0 nights is a single day there); default: each stop feature's "nights". With --nights the stop features' "nights"
  become the total per stop (dots under the name).
  Each day: title "Tue 20 Oct · Hualien" (travel days "Fri 23 Oct · Taipei → Hualien"), a lighting hour
  ("time" with "time_hint": true, never shown as a clock time), focus (the stop's
  rank-1 stay from --stays, else the stop), items: the leg (with its sourced duration, or "check the timetable"),
  the base ("Base: <stay> · 4 min walk to <station>"), and up to --per-day places per layer from --sights (features
  with "stop" = the stop id, else the nearest stop within 60 km; an item copies the feature's source_url/source as its
  link; --sights may list several layers, e.g. sights,food,daytrips). A stop's places are grouped by area: the
  closest ones share a day, each day's in walking order from the base (a loop), the area nearest the base first; the
  first day of the trip (its arrival, no travel before it) is one of its days: it takes an area too as soon as there are
  more places than full days, so every day before the departure gets a place before any gets a second, and none a
  third while another of the stop's days has one: that day takes the nearest place of a day with three or more
  (never one the day-places check below would send back: a place a ride away from it). The day a later stop is
  reached is one of its days too after a short ride (plan-checks.json arrival_ride_max_min, by the leg's time, else
  the estimate from its distance): it takes places once the stop has two with their own page for each of its days,
  that day counted, as days of two near each other that the day-places check passes where the full days alone pass;
  until then it is not one of the stop's days to see, and the plan says what it still needs. A full day that gets sourced
  places gets a text from them instead of "Day in …": their names, the first with its "why" (the reason its page
  gives), ≤ 140 characters. A trip of several stops ends with the departure, the day after the last night ("depart":
  true, "Leave <stop>."): nothing is planned on it. The map's first view then frames the trip (its stops, --stays,
  --legs and --sights layers) and every layer \`uw fit\` frames. Prints a warning for a place that is far from its day's other places or closer to another day's
  (plan-checks.json). Run again, it replaces the days it wrote, by itself: each day keeps its own note (uw set
  <dir> plan:day<N> --note) and its own words (a text written over the one this command wrote; in a plan that keeps
  no "texts", any text that is not one this command writes for that day), named so you check they still fit its
  places; a note or text of a day the new plan no longer has is named too. Days with no sourced place keep "Day in …":
  add places. --sights also says the trip is about what to see each day, and a full day (the arrival day of the trip
  too) takes 2-3 places, each with its own page (a place the person named, "asked": true, counts as it is, marked not
  checked while it has none): while the turn clock shows more than about 3 minutes left and the place search answers,
  a plan whose full days would have fewer than two is refused (exit 2), naming those days, each place
  pinned with no page (with the reference search that finds its own site, else its Wikipedia article: keep it, never
  remove it), how many more places to add near each base (near a day's own place when it lies out of the base's
  area: a day trip), and near where to add one instead of a place whose page cannot be found; do that, then run the
  same command again. Run again with the same places once another was looked for after the refusal (uw add-point ran
  on one of those layers: none found, or none with a page of its own), it writes the days as they are: a full day with one place is
  kept, a warning the reply names (the plan's "kept"; JSON "kept_short"); with nothing looked for it is refused as
  before, and a full day with nothing to see is refused each time while the turn has time. A map with no days yet still
  gets them, as they are, as a draft ("draft"; JSON "draft": true,
  with the days for a reply that cannot wait): no trip map is left without its Plan tab. The next uw plan replaces a
  draft, keeping a day's text written over the draft's on its day (named). In the turn that wrote it,
  uw add-point (a place pinned) and uw validate plan a draft again once its places change, so its days have what the
  map has (still a draft). A map whose days are already there keeps them (nothing written). With less time left, the place search down, or a uw command still running on the site (named
  below), the days are written as they are. A place with no page of its own (none, or one taken with too little time
  left that is not its own) is marked not checked in its day. A place the person named is never left off the days
  while a day has a place of its kind they did not name (it takes that place's room). The plan keeps those layers ("sights")
  and when it planned the days ("planned_at"), and \`uw validate\` fails while a full day has no sourced place, and while a place of
  those layers is in no day and not one the plan lists as left out ("unplaced": no room, or far from every stop): it
  was pinned after the days were planned. In the turn that planned the days it also fails a full day with one sourced
  place while the turn clock shows more than about 3 minutes left; a later turn only warns (it keeps the days the
  person changed), and so does a day this command kept (above): the plan and the check say the same of it. --per-day 1 (kept as "per_day") is only for a person who asked for one place a day. With it, a day
  takes one. uw commands still running on the site (a place lookup whose command has not
  finished) are named, in the JSON too ("still_running"): what they find is not in the plan yet; wait until each has
  finished, then plan again. A trip of several stops: each stop's days to see are printed against the nights the map
  expects (uw new --expect; JSON "stop_days"), with why a stop has fewer (the day it is reached goes to a long ride,
  or has nothing to see yet: JSON "nothing_yet"; uw validate warns of such a day too, the plan's "after_ride") for the
  reply to say. The stay or route for the reply, with its dates and the "Assumed:" line they
  need, is in the JSON too ("for_the_reply"), and with --sights the days for the reply, each with its places as the
  map has them ("days_for_the_reply").`;

/** A plan `uw plan` wrote while it refused days short of places: the days as they were, with how it was asked for
 *  ("draft": its arguments, `inputs`, planInputs' of the places it was made of, and `texts`, textKey's of the day texts
 *  it wrote). Replaced by the next uw plan; planned again in the turn that wrote it once its places change
 *  (planDraftAgain), and still a draft then. */
export const isDraft = (plan) => !!plan && typeof plan.draft === 'object' && plan.draft !== null && typeof plan.draft.start === 'string' && typeof plan.draft.stops === 'string';
/** A day's text as a draft keeps it (a short hash): a text that differs is the turn's own words. Pure. */
const textKey = (t) => crypto.createHash('sha256').update(String(t ?? '')).digest('hex').slice(0, 12);
/** Is a day's text one `uw plan` writes for that day: its skeleton ("Day in …", the arrival, a travel or departure
 *  day), or its places' names as they are now (dayTextFrom; on an arrival or a travel day after "… Then: ")? For a
 *  plan that keeps no "texts" (written before they were kept, or by hand), what is not is the day's own words.
 *  `placeOf(ref)`: the place an item names. Pure. */
function planWroteText(d, placeOf) {
  const t = String(d?.text ?? '').trim();
  if (SKELETON_DAY.test(t) || ARRIVAL_DAY.test(t) || isPlanSkeletonText(t)) return true;
  const feats = (Array.isArray(d?.items) ? d.items : []).filter((it) => it?.ref && !/^Base: /.test(String(it.text || '')))
    .map((it) => placeOf(it.ref)).filter((f) => typeof f?.properties?.source_url === 'string');
  if (!feats.length) return false;
  if (t === dayTextFrom(feats)) return true;
  const m = t.match(/^((?:Arrive in .+?; night 1 of \d+|Travel day; night 1 of \d+ in .+?)\.) Then: /);
  return !!m && t === `${m[1]} Then: ${dayTextFrom(feats, 140 - m[1].length - 7)}`;
}
/** Plan a draft's days again (uw plan, with the arguments it was asked with), in the turn that wrote it, once the
 *  places it was made of changed, while no other uw command runs on the site and outside a step of uw handoff --apply
 *  (it plans the days itself): what uw add-point does once it pinned a place, and uw validate first. A turn pinned two
 *  places after a refused plan, its next command hung, and it replied with days that had neither. The days stay a
 *  draft (UW_PLAN_DRAFT): the turn's own uw plan, the same command the refusal named, still replaces them, and only
 *  a draft is planned again here, so a plan that is no longer one is never replaced unasked. A day's text the turn
 *  wrote over the draft's stays on its day (run). `dir`: the site's folder; `siteArg`: as the command was given it.
 *  → null (nothing to do, or it could not run) or { days_for_the_reply, short (days still short of places),
 *  kept_texts? (the days that kept their own text) }. */
export function planDraftAgain(dir, siteArg, { turnStartedMs = null } = {}) {
  let cfg = null;
  try { cfg = readJSON(path.join(dir, 'map.config.json')); } catch { return null; }
  if (!isDraft(cfg?.plan) || handoffStep()) return null;
  if (turnStartedMs != null && !(Date.parse(cfg.plan.planned_at ?? '') >= turnStartedMs)) return null;
  if (stillRunning(dir).length) return null;
  let site = null;
  try { site = openSite(dir); } catch { return null; }
  const featuresOf = (id) => { try { return loadLayer(site, id, { required: false })?.features || []; } catch { return []; } };
  if (planInputs(cfg.plan.draft, featuresOf) === cfg.plan.draft.inputs) return null;
  const uwMjs = fileURLToPath(new URL('../uw.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [uwMjs, 'plan', siteArg, ...draftArgs(cfg.plan.draft), '--json'],
    { encoding: 'utf8', env: { ...process.env, UW_PLAN_DRAFT: '1' }, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout || ''); } catch { return null; }
  if (!json || (r.status !== 0 && r.status !== 2)) return null;
  return { days_for_the_reply: json.days_for_the_reply || null, short: r.status === 2, ...(json.kept_texts?.length ? { kept_texts: json.kept_texts } : {}) };
}
/** The days that kept their own text, said for the turn (" Day 2 keeps its own text: …"), or ''. */
const keptTextsLine = (days) => (!days?.length ? '' : days.length === 1 ? ` Day ${days[0]} keeps its own text: check it still fits its places.`
  : ` Days ${days.slice(0, -1).join(', ')} and ${days[days.length - 1]} keep their own texts: check each still fits its places.`);
/** What uw add-point and uw validate say of a draft they planned again (planDraftAgain's). */
export const draftAgainLine = (r, since) => `Days planned again ${since}${r.short ? ' (still short of places)' : ''}: ${r.days_for_the_reply || 'none'}.${keptTextsLine(r.kept_texts)}`;
const REFUSED_FILE = 'plan-refused.json';
/** The last uw plan refused on the site in `dir` for days short of places: { inputs (planInputs' of what it was made
 *  of), tried (the layers uw add-point ran on since: a place looked for, found or not) }, or null. Kept in the site's
 *  state folder (lib/state-dir.mjs), so a refusal over days already on the map still writes nothing to it. */
export function refusedPlan(dir, env = process.env) {
  for (const d of stateDirsOf(dir, env)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, REFUSED_FILE), 'utf8'));
      if (typeof j?.inputs === 'string') return { inputs: j.inputs, tried: Array.isArray(j.tried) ? j.tried.map(String) : [] };
    } catch { /* none */ }
  }
  return null;
}
function writeRefused(dir, rec, env = process.env) {
  const file = path.join(stateDirOf(dir, env), REFUSED_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...rec, at: new Date().toISOString() }));
    fs.renameSync(tmp, file);
  } catch { /* best effort: the next run refuses once more */ }
}
/** uw add-point ran on `layer` of the site in `dir`: after a refused plan, that is a place looked for (found or not).
 *  uw plan keeps a day with one place only once the turn has looked for another (run). */
export function noteLookupTried(dir, layer, env = process.env) {
  const rec = refusedPlan(dir, env);
  if (rec && !rec.tried.includes(String(layer))) writeRefused(dir, { inputs: rec.inputs, tried: [...rec.tried, String(layer)] }, env);
}
const DRAFT_ARGS = ['stops', 'ids', 'nights', 'start', 'legs', 'stays', 'sights', 'per-day', 'title'];
/** The arguments a draft keeps, to plan it again (draftArgs). */
function draftOf(args) {
  const d = {};
  for (const k of DRAFT_ARGS) if (args[k] != null && args[k] !== '') d[k === 'per-day' ? 'per_day' : k] = k === 'per-day' ? Number(args[k]) : String(args[k]);
  return d;
}
/** A draft's arguments for uw plan again (its site aside). Pure. */
export function draftArgs(d) {
  return DRAFT_ARGS.flatMap((k) => { const v = d?.[k === 'per-day' ? 'per_day' : k]; return v == null || v === '' ? [] : [`--${k}`, String(v)]; });
}
/** What a plan's days are made of, as a short hash: each place of its layers (stops, stays, legs, places to see) by
 *  layer, id, point, stop, rank, page and the named mark (a stop's nights come from the arguments, or are written
 *  with the plan). `featuresOf(layer id)` → features. Pure. */
export function planInputs(d, featuresOf) {
  const rows = [];
  for (const id of new Set([d?.stops, d?.stays, d?.legs, ...parseList(d?.sights || '')].filter(Boolean))) {
    for (const f of featuresOf(id) || []) {
      const p = f?.properties || {};
      const at = f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates.slice(0, 2).map((x) => Math.round(Number(x) * 1e5)) : null;
      rows.push(JSON.stringify([id, p.id ?? null, at, p.stop ?? null, p.rank ?? null, p.source_url ?? null, p.asked === true]));
    }
  }
  return crypto.createHash('sha256').update(rows.sort().join('\n')).digest('hex').slice(0, 16);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (d) => `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
const label = (p) => p?.name_en || p?.station_of || p?.name || p?.id;
const cityOf = (p) => {
  const c = p?.station_of || String(label(p)).replace(/\s*(main\s+)?(railway\s+|train\s+)?station$/i, '');
  return p?.station_kind === 'hsr' && !/HSR|high.?speed/i.test(c) ? `${c} HSR` : c; // Tainan → Tainan HSR, not Tainan → Tainan
};
/** A stop that is a railway station (uw station), so a stay's walk is "to the station"; any other stop (a district,
 *  a city centre) is named. */
const isStation = (p) => !!p?.station_of || p?.kind === 'train_station';

const SKELETON_DAY = /^Day in .+?(?:; night \d+ of \d+)?\.$/;
/** The trip's first day as \`uw plan\` writes it: the arrival, before its places are added ("… Then: <places>"). */
const ARRIVAL_DAY = /^Arrive in .+; night 1 of \d+\.$/;

/** The departure day `uw plan` writes (marked "depart"; older plans: a title ending ": depart"). Nothing is planned on
 *  it, so it is never an empty day to fill. */
export function isDepartDay(d) {
  return d?.depart === true || /: depart$/.test(String(d?.title || ''));
}

/** The day texts `uw plan` writes itself on travel and departure days. They restate the route (the leg item carries
 *  its own link), so the validator's "day text with no sourced item" rule leaves them alone. */
export function isPlanSkeletonText(text) {
  return /^(?:Leave .+\.|Travel day(?:; night 1 of \d+ in .+| via .+|; leave from .+)\.)$/.test(String(text ?? '').trim());
}

/** Full days (a day at a stop, not travel and not the departure; the trip's arrival day too: "3 days in Lisbon" is
 *  three days to fill, the first one the arrival) still as `uw plan` wrote them: nothing but the base and the skeleton
 *  text; and thin ones: fewer than two sourced items (a day with one sight is not "2-3 a full day" yet), or none when
 *  the plan was made for one place a day (`uw plan --per-day 1`: the turn clock never pushes a person who asked for it
 *  into more). "single" names every day with one place, that plan's too: validate warns on them in the turn that
 *  planned the days (a turn once planned one a day nobody asked for, to pass the check).
 *  Pure; used by validate and the turn clock to say "add sights" while there is time. */
export function emptyPlanDays(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const want = Number.isInteger(plan?.per_day) && plan.per_day < 2 ? 1 : 2;
  const full = fullDays(days);
  const onlyBase = (d) => !Array.isArray(d.items) || d.items.every((it) => /^Base: /.test(String(it?.text || '')));
  const empty = full.filter((d) => onlyBase(d) && (SKELETON_DAY.test(String(d.text || '')) || ARRIVAL_DAY.test(String(d.text || ''))));
  const thin = full.filter((d) => sourcedItems(d) < want);
  // nothing to see: not one sourced place (a pinned place with its page, or a place with only its page's link)
  const bare = full.filter((d) => sourcedItems(d) === 0).map((d) => String(d.title || ''));
  // one place to see: the day still needs one or two more
  const single = full.filter((d) => sourcedItems(d) === 1).map((d) => String(d.title || ''));
  return { empty: empty.length, thin: thin.length, full: full.length, days: days.length, bare, single };
}
/** What a day's item for a place the person named ("asked") says while no page of its own was read: the Plan tab shows
 *  "Not checked · on a page of its own" (config.md, an item's "check"). */
export const NOT_CHECKED = 'on a page of its own';
/** An item that counts as a place to see on its day: it links the page its facts came from, or it is a place the person
 *  named ("asked": true), which counts as they gave it, as a value the person gave does (the base is not a place to see). */
const counts = (it) => (it?.asked === true || (typeof it?.url === 'string' && /^https?:\/\//.test(it.url))) && !/^Base: /.test(String(it?.text || ''));
function sourcedItems(d) {
  return (Array.isArray(d?.items) ? d.items : []).filter(counts).length;
}
/** A plan's full days: a day at a stop, not travel and not the departure (the trip's arrival day too). */
const fullDays = (days) => days.filter((d) => !String(d?.title || '').includes('→') && !isDepartDay(d));
/** The full days with fewer than `want` places that have their own page, each as { day, have }: what `uw plan --sights`
 *  refuses to write while the turn has time to add places. Pure; exported for the tests. */
export function shortDays(days, want = 2) {
  return fullDays(Array.isArray(days) ? days : []).map((day) => ({ day, have: sourcedItems(day) })).filter((x) => x.have < want);
}
/** What `uw plan` says when it refuses days short of places (`short`: shortDays'): the days, and how many places to add
 *  near each base (the days' focus: the stop's first stay, else the stop), each from its own page, as the trip guide
 *  adds them; then the same command again. A day whose place lies out of the base's area (a day trip, a district a
 *  ride away: farther than the grouping's one area, `sameAreaKm`) takes them near that place: the days are grouped by
 *  area, so places added near the base went to the base's days, and the third landed on the day trip's day.
 *  A place pinned with no page of its own counts on no day until it has one: the refusal names each, with the way the
 *  trip guide finds a place's page (the venue's own site from the reference search, else its Wikipedia article, then
 *  uw cite), and asks for new places only where those cannot fill a day. A turn once removed every sight it had
 *  pinned, the two the person named among them, right after a refusal that named no way to a page.
 *  `focusOf(ref)` / `placeOf(ref)`: the feature a day's focus / item names; `days`: all the days (for the places pinned
 *  with no page); `searchFor(item)`: the words to search a place by. → { lines, json }. Pure. */
export function shortDaysRefusal({ site, short, want, full, layers, focusOf, placeOf = () => null, stopLayer, sameAreaKm = planChecks().same_area_km,
  days: all = short.map((x) => x.day), searchFor = (it) => String(it.text || it.ref.id), drafted = false, again = null }) {
  const bases = new Map();
  const place = (it) => it?.ref && layers.includes(it.ref.layer) && !/^Base: /.test(String(it.text || ''));
  const noPage = (it) => place(it) && !counts(it);
  for (const { day, have } of short) {
    const ref = day.focus || null;
    const f = focusOf(ref);
    const items = Array.isArray(day.items) ? day.items : [];
    // the day's own place (with its page or pinned with none), when it lies out of the base's area
    const item = items.find(place);
    const own = item ? placeOf(item.ref) : null;
    const apart = own ? km(pointOf(own), pointOf(f)) : Infinity;
    const away = Number.isFinite(apart) && apart > sameAreaKm;
    const at = away ? own : f;
    const key = away ? `${item.ref.layer}:${item.ref.id}` : ref ? `${ref.layer}:${ref.id}` : '';
    if (!bases.has(key)) {
      const pt = pointOf(at);
      bases.set(key, { name: at ? String(label(at.properties)) : null, near: pt ? pt.slice(0, 2).map((x) => +x.toFixed(6)).join(',') : null,
        stop: at?.properties?.stop != null ? String(at.properties.stop) : f?.properties?.stop != null ? String(f.properties.stop) : ref && ref.layer === stopLayer ? String(ref.id) : null, places: 0, instead: 0, base: !away, days: [] });
    }
    // what the places pinned there with no page cannot fill once they have it, and what they fill only once they have
    // it: where no page of its own can be found for one, another place near there takes its room (it stays pinned)
    const could = Math.min(want - have, items.filter(noPage).length);
    bases.get(key).places += want - have - could;
    bases.get(key).instead += could;
    if (could) bases.get(key).days.push(String(day.title));
  }
  const nearOf = (b) => `near ${b.name || 'its base'} (${[b.near && `--near ${b.near}`, b.stop && `"stop":"${b.stop}"`].filter(Boolean).join('; ')})`;
  const add = [...bases.values()].filter((b) => b.places > 0);
  const total = add.reduce((n, b) => n + b.places, 0);
  const one = add.length === 1 ? add[0] : null;
  const where = one ? `${total} more place${total === 1 ? '' : 's'} near ${one.base ? 'the base, ' : ''}${one.name || 'its base'}${one.near ? ` (--near ${one.near})` : ''}`
    : `${total} more places: ${add.map((b) => `${b.places} ${nearOf(b)}`).join(', ')}`;
  const instead = [...bases.values()].filter((b) => b.instead > 0);
  const alt = instead.length === 1 ? instead[0] : null;
  const insteadLine = instead.length ? `Where no page of its own can be found for one of those places on ${instead.flatMap((b) => b.days).join(', ')}, keep it and add another place `
    + `${alt ? `near ${alt.base ? 'the base, ' : ''}${alt.name || 'its base'}${alt.near ? ` (--near ${alt.near})` : ''} instead` : `instead, ${instead.map(nearOf).join(', ')}`}` : null;
  const pinned = [...new Map(all.flatMap((d) => (Array.isArray(d?.items) ? d.items : []).filter(noPage)).map((it) => [`${it.ref.layer}:${it.ref.id}`, it]))];
  const search = (it) => `instafy web search "${String(searchFor(it)).replace(/["\\$`]/g, (c) => `\\${c}`)}" --chain reference-search --json`;
  const many = pinned.length > 1;
  // no way past this but pages: marking a place as one the person named is for a place their message named, when it
  // is pinned (reference/itinerary.md "One base" step 3), never offered here
  const lines = pinned.length ? [`${many ? `The ${pinned.length} places` : 'The place'} pinned with no page ${many ? 'count on no day until each has' : 'counts on no day until it has'} its own: `
    + `keep ${many ? 'them' : 'it'} (never remove a place to get past this). ${many ? 'Each one\'s' : 'Its'} page: its own site from the reference search below, else its Wikipedia `
    + `article; uw cite <that page> --grep "<its name>", then uw set ${site} <layer>:<id> --props-file - with {"source_url":"<that page>","source":"<site>"}.`, ...pinned.map(([ref, it]) => `  ${ref}: ${search(it)}`)] : [];
  const how = (b) => `uw cite <that page> --grep "<its name>", then uw add-point ${site} --layer ${layers[0]} --near ${b?.near || '<that point>'} … `
    + `with {"stop":"${b?.stop || '<its stop>'}","source_url":"<that page>","source":"<site>"}, one place per command (reference/itinerary.md Phase B step 1).`;
  if (add.length) lines.push(`Add ${where}, each from its own page (${OWN_PAGE_WAY}): ${how(one)}${insteadLine ? ` ${insteadLine}, the same way.` : ''} Then run this command again.`);
  else if (insteadLine) lines.push(`${insteadLine}, from its own page (${OWN_PAGE_WAY}): ${how(alt)} Then run this command again.`);
  else lines.push('Then run this command again.');
  // what the same command does when the turn has none to add: said here, so no turn looks for a way to force it (one
  // ran the plan a third time with --force, as its hints said, and was refused all the same)
  if (again) lines.push(again);
  const next = lines.join('\n');
  const days = short.map(({ day, have }) => `${day.title} (${have})`);
  const written = drafted ? 'The days are on the map as they are for now: a draft, which this command replaces.' : 'Nothing was written.';
  const first = want < 2
    ? `REFUSED: ${short.length} of ${full} full days would have no place to see with its own page (one a day: --per-day 1): ${days.join(', ')}. ${written}`
    : `REFUSED: ${short.length} of ${full} full days would have fewer than 2 places to see with their own page (a full day takes 2-3): ${days.join(', ')}. ${written}`;
  return { lines: [first, ...lines], json: { ok: false, refused: 'days_short_of_places', places_a_day: want,
    short_days: short.map(({ day, have }) => ({ title: day.title, places: have })), add: add.map(({ base, instead: _, days: __, ...b }) => b),
    ...(instead.length ? { instead: instead.map(({ name, near, stop, instead: places, days: on }) => ({ name, near, stop, places, days: on })) } : {}),
    ...(pinned.length ? { no_page: pinned.map(([ref, it]) => ({ ref, name: String(it.text || ''), search: search(it) })) } : {}), next } };
}

/** The route with nights and dates, one line, for the reply ("Taipei 3 → Hualien 2 → … (Tue 20 Oct – Tue 3 Nov)"):
 *  the night split is an assumption the traveller must see. The dates run to the day the traveller leaves: a plan
 *  with no departure day (days in one place) ends on its last night, so with `start` the line names the day after it.
 *  Pure; exported for the tests. */
export function routeLine(stops, nights, plan, start = null) {
  const parts = stops.map((s, i) => (nights[i] > 0 ? `${cityOf(s.props)} ${nights[i]}` : null)).filter(Boolean);
  const days = plan?.days || [];
  const first = days[0]?.title?.split(' · ')[0];
  const total = nights.reduce((a, b) => a + b, 0);
  let last = days[days.length - 1]?.title?.split(' · ')[0];
  if (start && total > 0 && !days.some(isDepartDay)) {
    const leave = new Date(`${start}T00:00:00Z`);
    leave.setUTCDate(leave.getUTCDate() + total);
    if (!Number.isNaN(leave.getTime())) last = fmtDay(leave);
  }
  const when = first && last ? (first === last ? first : `${first} – ${last}`) : '';
  return `${parts.join(' → ') || cityOf(stops[0]?.props)} (${total} night${total === 1 ? '' : 's'}${when ? `, ${when}` : ''})`;
}

/** The line for the reply, printed the same in both outputs (with --json as "for_the_reply"): the stay or route with
 *  its dates, and the "Assumed:" line for the dates and nights the person did not give. With --json only the route was
 *  printed, and two replies named neither the dates nor that they were assumed. Pure; exported for the tests. */
export function replyLine(stopCount, route, plan, total) {
  const first = plan?.days?.[0]?.title?.split(' · ')[0];
  const example = first ? ` ("Assumed: arrive ${first}${total > 0 ? `, ${total} night${total === 1 ? '' : 's'}` : ''}")` : '';
  return `${stopCount === 1 ? 'Stay' : 'Route'} for the reply, with its dates: ${route}. ${stopCount === 1 ? 'The dates and nights' : 'The dates and the night split'} `
    + `are assumptions unless the person gave them: say those in the reply's "Assumed:" line${example}.`;
}

/** The days for the reply, as the plan has them ("<day title>: <place>, <place> (not checked)"): each full day's places
 *  by name, one not checked on a page of its own "(not checked)" (no page, or its item says so: a page taken with too
 *  little time left that is not its own), a full day with none "nothing to see yet"; a travel day only with places. A
 *  reply once promised a day around two places its turn had removed from the map. Pure; exported for the tests. */
export function daysForReply(plan) {
  const layers = Array.isArray(plan?.sights) ? plan.sights : [];
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const full = new Set(fullDays(days));
  return days.map((d) => {
    const places = (Array.isArray(d?.items) ? d.items : []).filter((it) => it?.ref && layers.includes(it.ref.layer))
      .map((it) => `${it.text}${typeof it.url === 'string' && /^https?:\/\//.test(it.url) && it.check !== NOT_CHECKED ? '' : ' (not checked)'}`);
    return places.length ? `${d.title}: ${places.join(', ')}` : full.has(d) ? `${d.title}: nothing to see yet` : null;
  }).filter(Boolean).join(' | ');
}

/** The stops in travel order with a stop named twice in a row merged into one stay (its nights added up): "Lisbon →
 *  Lisbon" is not a travel day. `at[i]`: where stay i's last entry was in the list given, so the leg out of it is the
 *  one with "order" at[i] + 1 (legs are numbered along the list they were made for). Pure; exported for the tests. */
export function collapseStops(stops, nights) {
  const s = [], n = [], at = [];
  stops.forEach((x, i) => {
    if (s.length && s[s.length - 1].id === x.id) { n[n.length - 1] += nights[i]; at[at.length - 1] = i; }
    else { s.push(x); n.push(nights[i]); at.push(i); }
  });
  return { stops: s, nights: n, at };
}

/** Each stop's places: a feature's "stop" when it is one of the stops, else the nearest stop within 60 km; a place
 *  farther from every stop is not part of the trip. Map stop id → features, in the order given. Pure. */
export function poolSights(stops, sights) {
  const pool = new Map(stops.map((s) => [s.id, []]));
  for (const f of sights) {
    const p = f.properties;
    let sid = p.stop && pool.has(p.stop) ? p.stop : null;
    if (!sid) {
      const c = representativePoint(f.geometry);
      let best = Infinity;
      for (const s of stops) { const d = haversine(c, s.coord); if (d < best && d < 60000) { best = d; sid = s.id; } }
    }
    if (sid) pool.get(sid).push(f);
  }
  return pool;
}

const pointOf = (f) => (f?.geometry ? representativePoint(f.geometry) : null);
const km = (a, b) => (a && b ? haversine(a, b) / 1000 : Infinity);

/** A stop that is a place of its own, as its "kind" says: a settlement or a bigger area (OpenStreetMap's place kinds),
 *  or where a traveller arrives (a station: `uw station` writes "station_of"; an airport, a port). Any other pin (a
 *  sight, a square, a neighbourhood, a pin with no kind) is a place inside a town. */
const OWN_PLACE = new Set(['city', 'town', 'village', 'hamlet', 'isolated_dwelling', 'island', 'islet', 'archipelago', 'municipality', 'county',
  'province', 'region', 'state', 'country', 'train_station', 'station', 'halt', 'aerodrome', 'airport', 'terminal', 'ferry_terminal', 'bus_station']);
const ownPlace = (p) => !!p?.station_of || OWN_PLACE.has(String(p?.kind ?? '').toLowerCase());
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Two stays in a row (nights at both, different stops) closer than trip_out_km are places in one city, not a trip:
 *  a turn made each day's pin a stop, and its plan had "Travel day … about 10 min by train" between neighbourhoods 2 km
 *  apart. A trip: two places of their own with different names (two towns on one coast, a night at the airport before
 *  the city), and a place of its own beside a stop that is not one when the map's "expect" names both as the trip's
 *  stops (a night at a hut above the town: uw validate asks for each in the plan). Two pins that are neither (sights,
 *  neighbourhoods) stay one city whatever "expect" says. A stop passed through (0 nights: an airport, a high-speed
 *  station out of town) is not a stay. `stops` and `nights` as collapseStops gives them; `expect` the map's (expectOf).
 *  → { a, b, km, nights, others } (the first such pair; nights: those of the run of close stays it starts, the one
 *  stop they become; others: the trip has stops besides them, a stop passed through too) or null. Pure; exported for
 *  the tests. */
export function sameCityStays(stops, nights, { maxKm = planChecks().trip_out_km, expect = [] } = {}) {
  const stays = stops.map((s, i) => ({ s, n: nights[i] })).filter((x) => x.n > 0);
  const named = (s) => expect.flatMap((e, i) => (featureNames(s.props, e.name) ? [i] : []));
  const namedApart = (a, b) => { const na = named(a), nb = named(b); return na.some((i) => nb.some((j) => j !== i)); };
  const oneCity = (a, b) => {
    if (a.id === b.id || !(km(a.coord, b.coord) < maxKm)) return false;
    const ownA = ownPlace(a.props), ownB = ownPlace(b.props);
    if (ownA && ownB) return sameName(cityOf(a.props), cityOf(b.props)) && !namedApart(a, b);
    return !((ownA || ownB) && namedApart(a, b));
  };
  for (let i = 0; i + 1 < stays.length; i++) {
    if (!oneCity(stays[i].s, stays[i + 1].s)) continue;
    let j = i + 1;
    while (j + 1 < stays.length && oneCity(stays[j].s, stays[j + 1].s)) j++;
    const run = stays.slice(i, j + 1), ids = new Set(run.map((x) => x.s.id));
    return { a: stays[i].s, b: stays[i + 1].s, km: km(stays[i].s.coord, stays[i + 1].s.coord), nights: run.reduce((t, x) => t + x.n, 0), others: stops.some((s) => !ids.has(s.id)) };
  }
  return null;
}

/** The places of one stay split into at most `k` days by where they are: two groups merge while their farthest pair
 *  of places is the closest of any two groups (so a day never spans two areas when another split exists), never past
 *  `perDay` places of one layer. Places closer than `sameAreaKm` count as one area: there the smaller groups merge
 *  first, so the days share an area's places evenly. Fewer places than days: one each (spread, as before). Places that
 *  fit no day stay off the plan, never a place the person named ("asked": true) while a day has one of its kind nobody
 *  named: it takes that place's room on the nearest such day (a plan left a named place off every day and kept the
 *  places the turn chose). Pure; exported for the tests. */
export function groupByArea(feats, k, perDay = 3, sameAreaKm = planChecks().same_area_km, rules = planChecks()) {
  if (k <= 0 || !feats.length) return [];
  const pt = feats.map(pointOf);
  const d = (i, j) => km(pt[i], pt[j]);
  const layerOf = (i) => feats[i]._layer ?? '';
  const fits = (a, b) => {
    const m = new Map();
    for (const i of [...a, ...b]) { m.set(layerOf(i), (m.get(layerOf(i)) || 0) + 1); if (m.get(layerOf(i)) > perDay) return false; }
    return true;
  };
  const link = (a, b) => { let m = 0; for (const i of a) for (const j of b) m = Math.max(m, d(i, j)); return m; };
  const groups = feats.map((_, i) => [i]).filter((g) => fits(g, []));
  while (groups.length > k) {
    let best = null;
    for (let x = 0; x < groups.length; x++) for (let y = x + 1; y < groups.length; y++) {
      if (!fits(groups[x], groups[y])) continue;
      const l = Math.max(link(groups[x], groups[y]), sameAreaKm), n = groups[x].length + groups[y].length;
      if (!best || l < best.l || (l === best.l && n < best.n)) best = { x, y, l, n };
    }
    if (!best) break;
    groups[best.x] = [...groups[best.x], ...groups[best.y]];
    groups.splice(best.y, 1);
  }
  // still more groups than days (one layer had more places than the days hold): the biggest groups are the days,
  // and each place of the others joins the nearest day with room
  groups.sort((a, b) => b.length - a.length || a[0] - b[0]);
  const kept = groups.slice(0, k);
  const left = [];
  for (const g of groups.slice(k)) for (const i of g) {
    let best = null;
    for (const h of kept) {
      if (!fits(h, [i])) continue;
      const l = Math.min(...h.map((j) => d(i, j)));
      if (!best || l < best.l) best = { h, l };
    }
    if (best) best.h.push(i); else left.push(i);
  }
  // a place the person named that found no room: the nearest day with a place of its kind nobody named gives it that
  // place's room (the one farthest from it), so the day stays around it
  const named = (i) => feats[i]?.properties?.asked === true;
  for (const i of left.filter(named)) {
    let best = null;
    for (const h of kept) {
      const others = h.filter((j) => !named(j) && layerOf(j) === layerOf(i));
      if (!others.length) continue;
      const l = Math.min(...h.map((j) => d(i, j)));
      if (!best || l < best.l) best = { h, l, out: others.reduce((a, b) => (d(i, b) > d(i, a) ? b : a)) };
    }
    if (best) best.h.splice(best.h.indexOf(best.out), 1, i);
  }
  // no day gets a third place while another has one: the day with one (or none that counts) takes the nearest place of
  // a day with three or more. A plan gave an arrival afternoon three places and the last day one, and the check then
  // failed that day. Places with their own page (or the person's named ones) are evened out first, as the check counts
  // them, then the others. A move is made only when the day-places check would flag no place it did not flag before,
  // on either day (dayPlaceWarnings: more than near_km from the day's other places while another day's is closer_ratio
  // times nearer, or more than far_km from them), so the check never sends a moved place back: two areas a ride apart
  // stay two days, and the plan names the short one
  const counted = (i) => placeCounts(feats[i]);
  // the places the day-places check flags, these groups being the stop's days
  const flagged = (days) => flaggedIn(days, d, rules);
  const even = (movable, size) => {
    for (let guard = feats.length * 2; guard > 0; guard--) {
      const before = flagged(kept);
      let best = null;
      for (const from of kept) {
        if (size(from) < 3) continue;
        for (const to of kept) {
          if (to === from || size(to) > 1 || !to.length) continue;
          for (const i of from.filter(movable)) {
            if (!fits(to, [i])) continue;
            const l = Math.min(...to.map((j) => d(i, j)));
            if (best && l >= best.l) continue;
            const after = flagged(kept.map((g) => (g === from ? g.filter((j) => j !== i) : g === to ? [...g, i] : g)));
            if ([...after].some((p) => !before.has(p))) continue;
            best = { from, to, i, l };
          }
        }
      }
      if (!best) break;
      best.from.splice(best.from.indexOf(best.i), 1);
      best.to.push(best.i);
    }
  };
  if (feats.some((_, i) => counted(i))) even(counted, (g) => g.filter(counted).length);
  even((i) => !counted(i), (g) => g.length);
  return kept.map((g) => g.sort((a, b) => a - b).map((i) => feats[i]));
}

/** The places the day-places check flags (dayPlaceWarnings, by these rules), `groups` being a stop's days and
 *  `dist(p, q)` the km between two of their places: more than near_km from its day's other places while another
 *  day's is closer_ratio times nearer, or more than far_km from them. → a Set of those places. Pure. */
function flaggedIn(groups, dist, rules = planChecks()) {
  const out = new Set();
  for (const g of groups) for (const p of g) {
    const own = g.filter((q) => q !== p);
    if (!own.length) continue;
    const near = Math.min(...own.map((q) => dist(p, q)));
    if (!(near > rules.near_km)) continue;
    let other = Infinity;
    for (const h of groups) if (h !== g) for (const q of h) other = Math.min(other, dist(p, q));
    if (other * rules.closer_ratio <= near || near > rules.far_km) out.add(p);
  }
  return out;
}

/** A day's places in walking order from the base: always the nearest next one (a loop that starts and ends at the
 *  base). Without a base, from the first place. Pure; exported for the tests. */
export function loopOrder(feats, base = null) {
  const left = [...feats];
  const out = [];
  let at = base || pointOf(left[0]);
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((f, i) => { const dd = km(at, pointOf(f)); if (dd < bd) { bd = dd; bi = i; } });
    const [f] = left.splice(bi, 1);
    out.push(f);
    at = pointOf(f) || at;
  }
  return out;
}

const CHECKS = (() => {
  try { const c = JSON.parse(fs.readFileSync(new URL('../plan-checks.json', import.meta.url), 'utf8')); return { ...c.grouping, ...c.day_places }; } catch { return {}; }
})();
/** The thresholds of the grouping and the day-places check (plan-checks.json), with `over` replacing any of them. */
export function planChecks(over = {}) {
  return { same_area_km: 1.5, first_day_over: 1, arrival_ride_max_min: 120, near_km: 1.5, closer_ratio: 2, far_km: 4, trip_out_km: 15, ...CHECKS, ...over };
}

const refOf = (r) => (typeof r === 'string' && r.includes(':') ? { layer: r.slice(0, r.indexOf(':')), id: r.slice(r.indexOf(':') + 1) }
  : r && typeof r === 'object' && r.layer != null && r.id != null ? { layer: String(r.layer), id: String(r.id) } : null);
const dayName = (d, i) => String(d?.title || `Day ${i + 1}`).replace(/^(?:[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*)+/u, '');
const fmtKm = (x) => (x < 10 ? `${Math.round(x * 10) / 10}` : `${Math.round(x)}`);

/** Places that do not belong with their day: each day's places (items that point at a point on the map; the base and
 *  the legs are not places) are compared by straight-line distance to the nearest other place. A place more than
 *  near_km from its day's others is flagged when another day has a place closer_ratio times nearer ("closer to
 *  another day's area": move it there), else when it is farther than far_km from all of them ("far apart"). A place
 *  more than trip_out_km from the day's base is a trip out and is left alone. `resolve(ref)` gives the feature of an
 *  item's ref. Returns [{ day, item, name, kind: "closer"|"far", km, other_day?, other_name?, other_km? }]. Pure. */
export function dayPlaceWarnings(plan, resolve, rules = planChecks()) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const per = days.map((d, i) => {
    if (isDepartDay(d)) return [];
    const focus = refOf(d?.focus);
    const baseF = focus ? resolve(focus) : null;
    const base = baseF?.geometry?.type === 'Point' ? baseF.geometry.coordinates : null;
    return (Array.isArray(d?.items) ? d.items : []).map((it, j) => {
      const r = refOf(it?.ref);
      if (!r || /^Base: /.test(String(it?.text || '')) || (focus && r.layer === focus.layer && r.id === focus.id)) return null;
      const f = resolve(r);
      if (f?.geometry?.type !== 'Point') return null;
      const c = f.geometry.coordinates;
      if (base && km(base, c) > rules.trip_out_km) return null;
      return { day: i, item: j, c, name: String(it.text || f.properties?.name_en || f.properties?.name || r.id).slice(0, 60) };
    }).filter(Boolean);
  });
  const out = [];
  for (const places of per) for (const p of places) {
    const own = places.filter((q) => q !== p);
    if (!own.length) continue;
    const near = Math.min(...own.map((q) => km(p.c, q.c)));
    if (!(near > rules.near_km)) continue;
    let other = null;
    for (const list of per) for (const q of list) {
      if (q.day === p.day) continue;
      const dd = km(p.c, q.c);
      if (!other || dd < other.km) other = { km: dd, q };
    }
    if (other && other.km * rules.closer_ratio <= near) {
      out.push({ day: p.day, item: p.item, name: p.name, kind: 'closer', km: near, other_day: other.q.day, other_name: other.q.name, other_km: other.km });
    } else if (near > rules.far_km) out.push({ day: p.day, item: p.item, name: p.name, kind: 'far', km: near });
  }
  return out;
}

/** One line per dayPlaceWarnings entry, for the agent: what is wrong and the move that fixes it. */
export function dayPlaceLine(w, days) {
  const at = `"${w.name}" (${dayName(days[w.day], w.day)})`;
  return w.kind === 'closer'
    ? `${at} is ${fmtKm(w.km)} km from that day's other places but ${fmtKm(w.other_km)} km from "${w.other_name}" on ${dayName(days[w.other_day], w.other_day)}: move it to that day (and reword both days' texts)`
    : `${at} is ${fmtKm(w.km)} km from every other place that day: group places that are close on one day`;
}

// Typical door-to-door speeds (km/h on the route's own length) for a leg no page gave a time for. The plan says
// "about … (estimate …)" so a leg is never a bare "check the timetable", and never passes for a sourced time.
const LEG_KMH = { train: 75, hsr: 200, bus: 50, car: 60, taxi: 50, ferry: 25, metro: 30, walk: 4.5, bike: 15 };
/** " · about 3 h by train (estimate from 210 km; check the timetable)", or the old wording when nothing is known. */
export function legEstimate(lp = {}, a = null, b = null) {
  const e = legGuess(lp, a, b);
  if (!e) return ' · times: check the timetable';
  return ` · about ${aboutMinutes(e.min)} by ${e.mode === 'hsr' ? 'high-speed train' : e.mode === 'car' ? 'car' : e.mode} (estimate from ${Math.round(e.dist)} km; check the timetable)`;
}
/** "40 min", "1.5 h": minutes as a plan says an estimate. */
const aboutMinutes = (min) => (min < 55 ? `${Math.max(10, Math.round(min / 10) * 10)} min` : `${Math.round(min / 30) / 2} h`);
/** A leg's ride from its length and its mode's typical speed: { min, dist (km), mode }, or null when neither is known. */
function legGuess(lp = {}, a = null, b = null) {
  const mode = String(lp.mode || 'train').toLowerCase();
  const kmh = LEG_KMH[mode];
  const routed = Number(lp.distance_km) > 0 ? Number(lp.distance_km) : null;
  const straight = a?.coord && b?.coord ? haversine(a.coord, b.coord) / 1000 : null;
  const dist = routed ?? (straight != null ? straight * (mode === 'flight' ? 1 : 1.25) : null);
  if (!kmh || !dist || dist < 1) return null;
  return { min: (dist / kmh) * 60, dist, mode };
}
/** How long the ride of a leg takes, in minutes: the time its page gave (uw legs --durations: "duration_min", the
 *  longer end of a range), else the estimate from its length (legEstimate's); null when neither is known. Pure;
 *  exported for the tests. */
export function legMinutes(lp = {}, a = null, b = null) {
  const sourced = Number(lp.duration_max_min ?? lp.duration_min);
  return Number.isFinite(sourced) && sourced > 0 ? sourced : legGuess(lp, a, b)?.min ?? null;
}

/** Build the plan days. Pure (exported for the tests). */
export function buildPlan({ stops: stopsIn, nights: nightsIn, start, legs = [], stays = [], sights = [], perDay = 3, title = 'Plan', notOwn = new Set() }) {
  if (stopsIn.length !== nightsIn.length) throw new UsageError(`--nights has ${nightsIn.length} values for ${stopsIn.length} stops`);
  if (!stopsIn.length) throw new UsageError('a plan needs at least one stop');
  const { stops, nights, at } = collapseStops(stopsIn, nightsIn);
  const days = [];
  const date = new Date(`${start}T00:00:00Z`);
  const next = () => { const d = new Date(date); date.setUTCDate(date.getUTCDate() + 1); return d; };
  // the leg at this place in the order that joins these two stops (a trip may go the same way twice, on different
  // trains); then any leg between them (legs made for another list); then the leg at this place from this stop. A leg
  // from a stop to itself, left from a list that named a stop twice in a row, is never a travel day.
  const legFor = (a, b, i) => {
    const order = at[i] + 1;
    const from = (f) => f.properties.from === a.id || f.properties.from_id === a.id;
    const to = (f) => f.properties.to === b.id || f.properties.to_id === b.id;
    return legs.find((f) => f.properties.order === order && from(f) && to(f))
      || legs.find((f) => from(f) && to(f))
      || legs.find((f) => f.properties.order === order && from(f) && f.properties.to !== a.id && f.properties.to_id !== a.id);
  };
  // a stay the research team picked (with its reason and source) is the base; then the ranked picks
  const stayFor = (s) => stays.filter((f) => f.properties.stop === s.id)
    .sort((x, y) => (y.properties.researched ? 1 : 0) - (x.properties.researched ? 1 : 0) || (x.properties.rank ?? 9) - (y.properties.rank ?? 9))[0] || null;
  // where a stop's days start and end: its base stay (when it is near the stop), else the stop itself
  const baseOf = (s) => { const c = pointOf(stayFor(s)); return c && km(c, s.coord) < 60 ? c : s.coord || c || null; };
  // sights per stop: explicit "stop", else the nearest stop within 60 km
  const pool = poolSights(stops, sights);
  // a place the person named ("asked": true) counts on its day as they gave it. A place with no page of its own (none,
  // or one taken with too little time left that is not its own: `notOwn`, "<layer>:<id>") is marked not checked, so
  // the Plan tab and the reply's days say so (the Plan tab marked only the places the person named)
  const sightItem = (f) => {
    const p = f.properties;
    const unchecked = !p.source_url || notOwn.has(`${f._layer}:${p.id}`);
    return { text: p.name_en || p.name, ref: { layer: f._layer, id: p.id }, ...(p.source_url ? { url: p.source_url } : {}), ...(p.source && p.source_url ? { source: String(p.source).slice(0, 40) } : {}),
      ...(p.asked === true ? { asked: true } : {}), ...(unchecked ? { check: NOT_CHECKED } : {}) };
  };
  // how the base is reached from its stop: the walk when it is known, else, for a stay farther out than a walk (a
  // hotel in town at a far station), the distance and the ride, so a far station is never silent (Taitung)
  const toStop = (s, st) => {
    const p = st.properties;
    const to = isStation(s.props) ? 'the station' : (p.walk_to || cityOf(s.props));
    if (p.walk_min && p.walk_min <= 20) return ` · ${p.walk_min} min walk to ${to}`;
    const c = st.geometry ? representativePoint(st.geometry) : null;
    const m = c && s.coord ? haversine(c, s.coord) : null;
    if (m == null || m < 1500) return p.walk_min ? ` · ${p.walk_min} min walk to ${to}` : '';
    const dist = m < 9500 ? Math.round(m / 100) / 10 : Math.round(m / 1000);
    return ` · ${dist} km from ${to}: taxi or local bus`;
  };
  const baseItem = (s) => {
    const st = stayFor(s);
    if (!st) return null;
    const p = st.properties;
    // the researcher's reason, not the register's boilerplate ("registered hotel, 16 rooms")
    const why = p.researched && typeof p.why === 'string' ? clipWords(p.why, 90) : '';
    const name = p.name_en && p.name_en !== p.name ? `${p.name_en} (${p.name})` : p.name;
    const url = [p.source_url, p.website].find((u) => typeof u === 'string' && /^https?:\/\//.test(u));
    const source = url ? (url === p.source_url && p.source ? String(p.source) : new URL(url).hostname.replace(/^www\./, '')).slice(0, 40) : null;
    return { text: `Base: ${name}${toStop(s, st)}${why ? ` · ${why}` : ''}`, ref: { layer: st._layer, id: p.id },
      ...(url ? { url, source } : {}) };
  };
  const focusOf = (s) => { const st = stayFor(s); return st ? { layer: st._layer, id: st.properties.id } : { layer: s.layer, id: s.id }; };
  // pass 1: the dated skeleton. Night 1 at a stop is its arrival day (day 1, or the travel day that gets there).
  const visits = []; // per stop visit: { stop, arrive: day, full: [days], first, ride: minutes of the ride there }
  let carry = null; // a travel day that goes on through a 0-night stop (A → B → C on one date)
  let rideIn = null; // the ride into the next stop, when its travel day is that one leg
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], n = nights[i];
    const city = cityOf(s.props);
    const visit = { stop: s.id, s, arrive: null, full: [], first: i === 0, ride: i > 0 ? rideIn : null };
    rideIn = null;
    if (i === 0 && n === 0 && stops.length === 1) {
      // one day in one place
      visit.arrive = { title: `${fmtDay(next())} · ${city}`, time: 10, time_hint: true, focus: focusOf(s), text: `Day in ${city}.`, items: [] };
      days.push(visit.arrive);
      visits.push(visit);
      continue;
    }
    // a first stop passed through (0 nights: an airport) has no day of its own: the trip starts with the travel day
    // that leaves it, so the next stop gets every night from the arrival date
    if (i === 0 && n > 0) {
      visit.arrive = { title: `${fmtDay(next())} · ${city}`, time: 15, time_hint: true, focus: focusOf(s), text: `Arrive in ${city}; night 1 of ${n}.`, items: [baseItem(s)].filter(Boolean) };
      days.push(visit.arrive);
    } else if (i > 0) visit.arrive = days[days.length - 1];
    for (let k = 2; k <= n; k++) {
      const d = { title: `${fmtDay(next())} · ${city}`, time: 10, time_hint: true, focus: focusOf(s), text: `Day in ${city}; night ${k} of ${n}.`, items: [] };
      days.push(d); visit.full.push(d);
    }
    if (n > 0) visits.push(visit);
    if (i < stops.length - 1) {
      const b = stops[i + 1];
      const leg = legFor(s, b, i);
      const lp = leg?.properties || {};
      const bCity = cityOf(b.props);
      const legText = `${lp.emoji || '🚆'} ${city} → ${bCity}${lp.duration ? ` · ${lp.duration}${lp.duration_source ? ` (${lp.duration_source})` : ''}` : legEstimate(lp, s, b)}`;
      const link = lp.duration_source_url || lp.timetable_url;
      const items = [leg ? { text: legText, ref: { layer: leg._layer, id: lp.id }, ...(link ? { url: link, source: String(lp.duration_source || 'Timetable').slice(0, 40) } : {}) } : { text: legText }];
      const bn = nights[i + 1];
      const through = bn === 0 && i + 1 < stops.length - 1;
      if (!through && bn > 0) { const base = baseItem(b); if (base) items.push(base); }
      const text = bn > 0 ? `Travel day; night 1 of ${bn} in ${bCity}.` : through ? `Travel day via ${bCity}.` : `Travel day; leave from ${bCity}.`;
      if (carry) { carry.title += ` → ${bCity}`; carry.items.push(...items); carry.focus = focusOf(b); carry.text = text; }
      else {
        days.push(carry = { title: `${fmtDay(next())} · ${city} → ${bCity}`, time: 9, time_hint: true, focus: focusOf(b), text, items });
        if (!through && bn > 0) rideIn = legMinutes(lp, s, b);
      }
      if (!through) carry = null;
    } else if (n > 0 && stops.length > 1) {
      // the day after the last night of a trip: the traveller leaves; nothing is planned on it, and the plan says so.
      // Days in one place have no such day: "3 days in Lisbon" is three dated days, not three and an empty fourth
      days.push({ title: `${fmtDay(next())} · ${city}: depart`, time: 9, time_hint: true, focus: focusOf(s), text: `Leave ${city}.`, depart: true, items: [] });
    }
  }
  // pass 2: a stop's places go on its full days grouped by area (≤ perDay of a layer each), each day in walking order
  // from the base, the area nearest the base first. The trip's first day (an arrival with no travel before it) takes
  // an area too when the full days would hold more than plan-checks.json's first_day_over places each (1: as soon as
  // there are more places than full days, so no day of the stay is left without one while another has two); a stop
  // with no full day gets them on its arrival day. A stop visited twice shares its places across both visits.
  const used = new Set();
  const placedOn = new Map(); // day → the sight features placed on it (for its text)
  for (const v of visits) {
    const visitsOfStop = visits.filter((x) => x.stop === v.stop).length;
    const share = Math.ceil((pool.get(v.stop) || []).length / visitsOfStop);
    const mine = (pool.get(v.stop) || []).filter((f) => !used.has(f.properties.id)).slice(0, share);
    // the day a later stop is reached may be one of its days (after a short ride, below): what it still needs
    const need = 2 * (v.full.length + 1);
    if (!mine.length) { if (v.full.length && shortRide(v)) v.unfilled = { have: 0, need, apart: [] }; continue; }
    const base = baseOf(v.s);
    let slots = v.full.length ? [...v.full] : [v.arrive];
    if (v.full.length && v.first && mine.length > v.full.length * planChecks().first_day_over) slots = [v.arrive, ...v.full];
    const centre = (g) => { const c = g.map(pointOf).filter(Boolean); return c.length ? [c.reduce((a, x) => a + x[0], 0) / c.length, c.reduce((a, x) => a + x[1], 0) / c.length] : null; };
    const grouped = (n) => groupByArea(mine, n, perDay)
      .map((g) => ({ g, d: base ? km(base, centre(g)) : 0 })).sort((a, b) => a.d - b.d).map((x) => x.g);
    let groups = null;
    // the day a later stop is reached is one of its days after a short ride ("4 days, two in each" gave the second city
    // one day: its first went to a ride of under an hour): it takes places once the stop has two that count for each of
    // its days, that day too, each day's lying together, and only as days the day-places check passes where the full
    // days alone pass (two places a step apart were split over the arrival day and the next, and the check flagged
    // each, sending them opposite ways). Else that day has nothing to see yet, and the plan says why (`unfilled`)
    if (v.full.length && shortRide(v)) {
      const have = mine.filter(placeCounts).length;
      const withArrival = have >= need ? grouped(v.full.length + 1) : null;
      const fair = !!withArrival && withArrival.length === v.full.length + 1;
      // the places that count on a day of fewer than two that count (the split made a day of one: it lies apart), else
      // the ones the check would flag on these days and not on the full days alone
      const alone = fair ? withArrival.filter((g) => g.filter(placeCounts).length < 2).flat().filter(placeCounts) : [];
      const dist = (a, b) => km(pointOf(a), pointOf(b));
      const without = fair && !alone.length ? flaggedIn(grouped(slots.length), dist) : null;
      const flagged = without ? [...flaggedIn(withArrival, dist)].filter((f) => !without.has(f)) : [];
      if (fair && !alone.length && !flagged.length) { slots = [v.arrive, ...v.full]; groups = withArrival; }
      else v.unfilled = { have, need, apart: (alone.length ? alone : flagged).map((f) => String(f.properties.name_en || f.properties.name || f.properties.id)) };
    }
    groups ||= grouped(slots.length);
    groups.forEach((g, i) => {
      const d = slots[i];
      for (const f of loopOrder(g, base)) {
        d.items.push(sightItem(f)); used.add(f.properties.id);
        if (!placedOn.has(d)) placedOn.set(d, []);
        placedOn.get(d).push(f);
      }
    });
  }
  // pass 3: a full day's text says what the day is for, from its sourced places (their names and the reason their
  // page gives, "why"), instead of "Day in Porto; night 2 of 3". An arrival day with places adds them.
  for (const [d, feats] of placedOn) {
    const sourced = feats.filter((f) => typeof f.properties.source_url === 'string');
    if (!sourced.length) continue;
    if (SKELETON_DAY.test(String(d.text || ''))) d.text = dayTextFrom(sourced);
    else if (/^Arrive in .+; night 1 of \d+\.$/.test(String(d.text || '')) || /^Travel day; night 1 of \d+ in .+\.$/.test(String(d.text || ''))) {
      const more = `${d.text} Then: ${dayTextFrom(sourced, 140 - d.text.length - 7)}`;
      if (more.length <= 140 && !/Then: $/.test(more)) d.text = more;
    }
  }
  // each stop's days to see: its full days, the trip's first day, and the day it is reached after a short ride (the
  // day of a longer ride, a stop passed through and the departure are none), for the plan to say against the nights the
  // map expects
  const stopDays = [];
  for (const v of visits) {
    let row = stopDays.find((r) => r.stop === v.stop);
    if (!row) stopDays.push(row = { stop: v.stop, name: cityOf(v.s.props), days: [], after_ride: [], ride_days: [] });
    if (v.first && v.arrive) row.days.push(v.arrive.title);
    // (a stop with no full day has its places on the day it is reached, whatever the ride: that day is its day)
    else if (v.arrive && (shortRide(v) || !v.full.length)) {
      row.days.push(v.arrive.title);
      row.after_ride.push({ title: v.arrive.title, min: v.ride == null ? null : Math.round(v.ride), full: v.full.length, ...(v.unfilled ? { unfilled: v.unfilled } : {}) });
    }
    else if (v.arrive && !v.first) row.ride_days.push({ title: v.arrive.title, min: v.ride == null ? null : Math.round(v.ride) });
    row.days.push(...v.full.map((d) => d.title));
  }
  // (not part of the plan that is written: read by the command, never listed with its keys)
  return Object.defineProperty({ title, days }, 'stop_days', { value: stopDays, enumerable: false });
}
/** Is the day this visit's stop is reached one of its days: after a ride of at most plan-checks.json's
 *  arrival_ride_max_min (a ride of unknown length is not)? */
const shortRide = (v) => !v.first && v.ride != null && v.ride <= planChecks().arrival_ride_max_min;
/** A place that counts on its day, as the check counts it: one with a page, or one the person named. */
const placeCounts = (f) => f?.properties?.asked === true || /^https?:\/\//i.test(String(f?.properties?.source_url ?? ''));

/** What uw plan says of each stop's days to see on a trip of several stops (buildPlan's stop_days), against the
 *  nights the map expects of it (uw new --expect: "4 days, two in each" is written "A:2,B:2"): "Days to see at each
 *  stop …: A 2 of 2 (Fri 20 Nov, Sat 21 Nov) · B 1 of 2 (Mon 23 Nov)", then why a stop has fewer (the day it is
 *  reached goes to the ride) with what the reply says of it. With places to see (`sightLayers`), the day a stop is
 *  reached after a short ride is one of its days to see once it has a place: until then it is not counted, and the
 *  plan says what that day still needs (more places with a page of their own, or ones that make its days near each
 *  other) and what the reply says meanwhile. A plan gave the second of two cities one day of the four, and neither it
 *  nor the reply said so; then it counted that city's day of the ride, with nothing on it, as one of its two.
 *  `expected`: expectOf's; `propsOf(stop id)`: the stop's properties. → { lines, json }. Pure; exported for the tests. */
export function stopDaysReport(built, { expected = [], propsOf = () => null, sightLayers = [] } = {}) {
  // a day with a place to see on it
  const placed = (title) => (built?.days || []).find((d) => d.title === title)?.items?.some((it) => it?.ref && sightLayers.includes(it.ref.layer)) || false;
  const rows = (built?.stop_days || []).map((r) => {
    const e = expected.find((x) => featureNames(propsOf(r.stop) || {}, x.name));
    // the day it is reached after a short ride, with nothing on it yet (a stop with no full day has its places on that
    // day, whatever the ride: it is its day)
    const empty = sightLayers.length ? r.after_ride.filter((x) => x.full > 0 && !placed(x.title)) : [];
    return { ...r, days: r.days.filter((t) => !empty.some((x) => x.title === t)), after_ride: r.after_ride.filter((x) => !empty.includes(x)), empty,
      expected: e && Number.isInteger(e.nights) && e.nights > 0 ? e.nights : null };
  });
  if (!rows.length) return null;
  const date = (title) => String(title).split(' · ')[0];
  const ride = (min) => (min == null ? 'a ride of unknown length' : `a ride of about ${aboutMinutes(min)}`);
  const maxH = Math.round(planChecks().arrival_ride_max_min / 6) / 10;
  const count = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
  const and = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const first = `Days to see at each stop${rows.some((r) => r.expected != null) ? ', against the nights the map expects' : ''}: `
    + `${rows.map((r) => `${r.name} ${r.days.length}${r.expected != null ? ` of ${r.expected}` : ''}${r.days.length ? ` (${r.days.map(date).join(', ')})` : ''}`).join(' · ')}.`;
  const lines = [first];
  // fewer than the map expects: the day the stop is reached goes to the ride (or its nights are fewer)
  for (const r of rows.filter((x) => x.expected != null && x.days.length < x.expected && !x.empty.length)) {
    const rides = r.ride_days.map((x) => `${date(x.title)} goes to ${ride(x.min)}`);
    lines.push(`${r.name} has ${r.days.length} of ${r.expected}: ${rides.length ? `${rides.join(', ')} (the day a stop is reached is one of its days only after a ride of up to ${maxH} h)` : 'it has fewer nights than the map expects'}. `
      + `Say that split in the reply ("${r.name}: ${count(r.days.length)} to see${rides.length ? `, ${date(r.ride_days[0].title)} is the ride there` : ''}"), or give it a night more when the trip's length allows.`);
  }
  // the day a stop is reached after a short ride, with nothing to see yet: what it still needs (more places with a
  // page of their own, or ones near those that would make a day alone or that the day-places check would flag), and
  // the split the reply says meanwhile
  for (const r of rows) for (const a of r.empty) {
    const u = a.unfilled || { have: 0, need: 2 * (a.full + 1), apart: [] };
    const few = u.have < u.need;
    const why = few ? `it takes places once ${r.name} has ${u.need} with a page of their own, two for each of its ${a.full + 1} days (it has ${u.have})`
      : `${r.name}'s ${u.have} places with a page of their own do not make ${a.full + 1} days of two near each other${u.apart.length ? ` (${and(u.apart.slice(0, 3))} ${u.apart.length === 1 ? 'lies' : 'lie'} apart from the others)` : ''}`;
    const add = few ? `add ${u.need - u.have} more in ${r.name}, each from its own page` : `add a place near ${u.apart.length ? and(u.apart.slice(0, 3)) : 'the others'}, from its own page`;
    lines.push(`${date(a.title)}, the day ${r.name} is reached (${ride(a.min)}), has nothing to see yet, so ${r.name} has ${count(r.days.length)} to see${r.expected != null ? ` of ${r.expected}` : ''}: ${why}. `
      + `While the turn has time, ${add}, then run this command again; else say that split in the reply ("${r.name}: ${count(r.days.length)} to see, ${date(a.title)} is the ride there").`);
  }
  return { lines, json: rows.map((r) => ({ stop: r.stop, name: r.name, days: r.days.length, ...(r.expected != null ? { expected: r.expected } : {}), on: r.days,
    ...(r.after_ride.length ? { after_ride: r.after_ride.map((x) => x.title) } : {}),
    ...(r.empty.length ? { nothing_yet: r.empty.map((x) => ({ title: x.title, has: x.unfilled?.have ?? 0, needs: x.unfilled?.need ?? 2 * (x.full + 1) })) } : {}),
    ...(r.ride_days.length ? { ride_days: r.ride_days } : {}) })) };
}

const LAYER_VERB = { food: 'Eat', daytrips: 'Day trip' };
/** "Livraria Lello (the 1906 bookshop; timed tickets) · Clérigos Tower · Eat: Café Santiago": the day's sourced places
 *  by name, the first with its page's reason when it fits; at most `max` characters, whole places only. Pure. */
export function dayTextFrom(feats, max = 140) {
  const name = (f) => String(f.properties.name_en || f.properties.name || '').replace(/\s+/g, ' ').trim();
  const why = (f) => String(f.properties.why || '').replace(/\s+/g, ' ').replace(/[.;,\s]+$/, '').trim();
  const part = (f, withWhy) => {
    const verb = LAYER_VERB[f._layer] ? `${LAYER_VERB[f._layer]}: ` : '';
    const w = withWhy ? why(f) : '';
    return `${verb}${name(f)}${w ? ` (${w})` : ''}`;
  };
  const parts = [];
  for (const [i, f] of feats.entries()) {
    if (!name(f)) continue;
    const next = [...parts, part(f, i === 0)].join(' · ');
    const plain = [...parts, part(f, false)].join(' · ');
    if (next.length <= max) parts.push(part(f, i === 0));
    else if (plain.length <= max) parts.push(part(f, false));
    else break;
  }
  return parts.join(' · ');
}

/** `turnLeftS`: seconds the turn clock leaves for tool work (uw.mjs; null: no clock, no limit). */
export async function run(argv, { turnLeftS = null, turnStartedMs = null } = {}) {
  const args = parseArgs(argv, { stops: 'string', start: 'string', ids: 'string', nights: 'string', legs: 'string', stays: 'string', sights: 'string', 'per-day': 'number', title: 'string', force: 'bool' },
    { positionals: [1, 1], command: 'plan' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  if (!args.stops) throw new UsageError('plan needs --stops <layer> (the stations/stops layer, e.g. --stops stations)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start || '') || Number.isNaN(Date.parse(`${args.start}T00:00:00Z`))) throw new UsageError('plan needs --start YYYY-MM-DD (the arrival date; state it as an assumption if the user gave none)');
  const stopLayer = checkLayerId(args.stops);
  const sfc = loadLayer(site, stopLayer);
  const byId = new Map(sfc.features.map((f) => [String(f.properties?.id), f]));
  const ids = args.ids ? parseList(args.ids) : sfc.features.map((f) => String(f.properties.id));
  const stopsIn = ids.map((id) => {
    const f = byId.get(id);
    if (!f) throw new UserError(`--ids: no "${id}" in layer ${stopLayer} (ids: ${[...byId.keys()].join(', ')})`);
    return { id, layer: stopLayer, props: f.properties, coord: representativePoint(f.geometry) };
  });
  if (!stopsIn.length) throw new UsageError(`a plan needs at least one stop: layer ${stopLayer} has none (--ids <stop id>)`);
  // a place to stay is never a trip's stop: the city is the stop and the hotel its stay, so each day reads the city's
  // name (a hotel made the stop titled every day after it, "Arrive in <hotel>", and left it off the places list). A
  // stay the map's "expect" names itself (a mountain hut asked for by name) is a stop
  const expected = expectOf(site.config);
  const askedFor = (p) => expected.some((e) => [p?.name, p?.name_en, p?.osm_name_en].some((n) => n && slugify(n) === slugify(e.name)));
  const stayStop = stopsIn.find((s) => (isLodging({ kind: s.props?.kind }) || sfc.uw?.cmd === 'stay') && !askedFor(s.props));
  if (stayStop) {
    const city = expected.length === 1 ? expected[0] : null;
    const slug = (city && slugify(city.name)) || '<city slug>';
    const name = label(stayStop.props);
    throw new UserError(`"${name}" is a place to stay, not a trip's stop: ${city ? `the city (${city.name})` : 'the city or town'} is the stop and "${name}" its stay, so each day reads ${city ? `"${city.name}"` : 'its name'}. `
      + `Pin the city: uw add-point ${args._[0]} --layer stops --query "${city ? city.name : '<City>'}" --kind city --id ${slug} --props '{"nights":${city?.nights ?? 'N'}}'; `
      + `give the stay that stop: uw set ${args._[0]} ${stopLayer}:${stayStop.id} --props '${JSON.stringify({ stop: slug })}'; then uw plan ${args._[0]} --stops stops --ids ${slug} … --stays ${stopLayer} (reference/itinerary.md "One base").`);
  }
  let nightsIn;
  if (args.nights) {
    nightsIn = parseList(args.nights).map(Number);
    if (nightsIn.some((x) => !Number.isInteger(x) || x < 0 || x > 60)) throw new UsageError('--nights: whole numbers 0-60, one per stop');
  } else {
    nightsIn = stopsIn.map((s, i) => (i > 0 && ids.indexOf(s.id) < i ? 0 : Number(s.props.nights)));
    if (nightsIn.some((x) => !Number.isInteger(x) || x < 0)) throw new UsageError(`some stops have no "nights": pass --nights ${stopsIn.map(() => 'N').join(',')} (or uw station … --nights N)`);
  }
  if (nightsIn.length !== stopsIn.length) throw new UsageError(`--nights has ${nightsIn.length} values for ${stopsIn.length} stops`);
  const { stops, nights } = collapseStops(stopsIn, nightsIn);
  // a wrong plan never reaches the map: stays a short ride apart in one city are one stop, whose days are its places
  // by area (a stop the map's "expect" names beside a town is the trip's, whatever its kind)
  const near = sameCityStays(stops, nights, { expect: expectOf(site.config) });
  if (near) {
    throw new UserError(`These are places in one city (${cityOf(near.a.props)} and ${cityOf(near.b.props)} are ${fmtKm(near.km)} km apart). `
      + `Plan one stop${near.others ? ' for them' : ''} (--ids <city> --nights ${near.nights}: the city, as reference/itinerary.md "One base" pins it)`
      + `${near.others ? ', with the trip\'s other stops as they are' : ''}; its sights are grouped into days by area.`);
  }
  const perDay = args['per-day'] ?? 3;
  const withLayer = (id) => { if (!id) return []; const fc = loadLayer(site, checkLayerId(id), { required: false }); return (fc?.features || []).map((f) => Object.assign(f, { _layer: id })); };
  // --sights takes several layers (sights,food,daytrips): every sourced place a lane or a follow-up pinned
  const legs = withLayer(args.legs), stays = withLayer(args.stays), sights = parseList(args.sights || '').flatMap((id) => withLayer(id));
  // run again, the command replaces the days it wrote, by itself: its own hints, its refusal and the trip guides all
  // named --force for that, and a turn then forced a plan it had been refused (it was refused all the same). What a
  // re-plan must not lose is kept below (a day's note, a day's own words); --force, still taken, replaces those words too
  const cfg = readJSON(site.cfgPath);
  // the places whose page is not their own, as uw validate judges them (taken with too little time left to cite):
  // marked not checked in their days, as validate tells the reply to name them
  const notOwn = sights.length ? notOwnPages(sights.map((f) => ({ lid: f._layer, f })), { turnStartedMs }).refs : new Set();
  const built = buildPlan({ stops: stopsIn, nights: nightsIn, start: args.start, legs, stays, sights, perDay, title: args.title || 'Plan', notOwn });
  // --sights: the ask is what to see each day, and a full day takes 2-3 places, each with its own page (one when the
  // person asked for one place a day: --per-day 1). While the turn has time to add places and the place search
  // answers, days short of them are refused here, before anything is written, with how many to add near each base: a
  // turn planned three sights over three days, uw validate failed those days with almost seven minutes left, and the
  // turn replied with the map unfinished. With less time left, or the place search down, the days are written as they
  // are and uw validate names them for the reply; so are a `uw handoff --apply` step's, whose report sends the turn on.
  // So are they while a uw command still runs on the site (a place lookup): what it finds is not counted yet, and the
  // plan names it (wait, then plan again), as it always has
  const sightLayers = parseList(args.sights || '');
  const stopDays = stops.length > 1 ? stopDaysReport(built, { expected, propsOf: (id) => byId.get(String(id))?.properties, sightLayers }) : null;
  const running = stillRunning(site.dir);
  const want = perDay < 2 ? 1 : 2;
  const short = sightLayers.length && !handoffStep() && !running.length ? shortDays(built.days, want) : [];
  // Refused on a map with no days yet (or only a draft), the days it can are still written, as they are: a draft the
  // next run of this command replaces, and that uw validate plans again in this turn once the places it was made of
  // change. A turn that never ran the plan again after a refusal left its map with no Plan tab at all, and a day's note
  // nowhere to go. A plan of days already there stays as it is (a later turn's, the person's)
  let refusal = null;
  const drafting = !cfg.plan || isDraft(cfg.plan);
  // a draft planned again on its own (planDraftAgain: uw add-point, uw validate) stays a draft, whatever the days now
  // have: the turn's own uw plan, the command the refusal named, still replaces it
  const again = process.env.UW_PLAN_DRAFT === '1' && isDraft(cfg.plan);
  // A refusal stands while the turn has not looked for more. Run again by the turn with the same places after it looked
  // for another (uw add-point ran on one of the plan's layers since: none found, or none with a page of its own), the
  // command writes the days as they are: a full day with one place to see is kept, a warning for the reply to name, as
  // uw validate then says too (the plan's "kept"). A turn was refused three times for one such day, the last time with
  // --force after two more places it tried were refused, and replied with its check failing though its reply named
  // the day. Run again with nothing tried, it is refused as before (three places for three days never pass by asking
  // twice), and a full day with nothing to see is never kept while the turn has time: it takes a place first
  const inputsNow = sightLayers.length ? planInputs(draftOf(args), (id) => (id === stopLayer ? sfc.features : withLayer(id))) : null;
  const canAdd = short.length > 0 && (turnLeftS == null || turnLeftS > REPLY_WITHIN_S) && !(await import('./cmd-geocode.mjs')).geocodeDown();
  const bare = short.filter((x) => x.have === 0);
  const refusedBefore = canAdd && !again ? refusedPlan(site.dir) : null;
  const keep = canAdd && !again && !bare.length && refusedBefore?.inputs === inputsNow && refusedBefore.tried.some((l) => sightLayers.includes(l));
  if (canAdd && !keep) {
    const focusOf = (ref) => (!ref ? null : ref.layer === stopLayer ? byId.get(String(ref.id)) : stays.find((f) => f._layer === ref.layer && String(f.properties?.id) === String(ref.id))) || null;
    const placeOf = (ref) => (ref ? sights.find((f) => f._layer === ref.layer && String(f.properties?.id) === String(ref.id)) : null) || null;
    // a place is searched by its name and its stop's (the city), as the trip guide's reference search takes it
    const searchFor = (it) => {
      const p = placeOf(it.ref)?.properties || {};
      const s = byId.get(String(p.stop)) || (stops.length === 1 ? sfc.features.find((f) => String(f.properties?.id) === stops[0].id) : null);
      const name = String(it.text || label(p)), town = s ? cityOf(s.properties) : '';
      return town && !name.toLowerCase().includes(town.toLowerCase()) ? `${name} ${town}` : name;
    };
    const nextTime = again ? null : bare.length
      ? 'A full day with nothing to see is refused again while the turn has time: each takes a place first. With too little time left the days are written as they are, and the reply names each.'
      : 'Looked for more after this refusal and none could be added (no other place found there, or none with a page of its own)? Run this command again as it is: a day with one place to see is then kept, as a warning the reply names.';
    refusal = shortDaysRefusal({ site: args._[0], short, want, full: emptyPlanDays(built).full, layers: sightLayers, focusOf, placeOf, stopLayer, days: built.days, searchFor, drafted: drafting, again: nextTime });
    // (the same places refused again keep what was tried since the first time)
    if (!again && refusedBefore?.inputs !== inputsNow) writeRefused(site.dir, { inputs: inputsNow, tried: [] });
    if (stopDays) refusal.json.stop_days = stopDays.json;
    if (!drafting) {
      if (out.json) process.stdout.write(JSON.stringify(refusal.json, null, 2) + '\n');
      console.error([...refusal.lines, ...(stopDays ? stopDays.lines : [])].join('\n'));
      return 2;
    }
  }
  // a day's own note (uw set <site> plan:dayN --note) is the person's: the new plan keeps it on the same day; one on a
  // day the new plan no longer has is named, never dropped quietly
  const oldDays = Array.isArray(cfg.plan?.days) ? cfg.plan.days : [];
  const noteOf = (d) => (typeof d?.note === 'string' && d.note.trim() ? d.note : null);
  const keptNotes = [];
  built.days.forEach((d, i) => { if (noteOf(oldDays[i])) { d.note = noteOf(oldDays[i]); keptNotes.push(i + 1); } });
  const lostNotes = oldDays.map((d, i) => ({ n: i + 1, note: noteOf(d) })).filter((x) => x.note && x.n > built.days.length);
  // the day texts this plan writes (a draft keeps them: a text that differs later is the turn's own words), and a day's
  // own words written over a draft's (the area a day is for, as the trip guide words it): they stay on that day (by its
  // title, its date) when the days are planned again, as a note does, named so the turn checks they still fit its
  // places; a draft is planned again on its own (planDraftAgain), and would otherwise put the places' names back over
  // them unseen. So do a plan's (its "texts"), now that planning again needs no flag: the words a turn gave a day are
  // not lost to the next uw plan. --force replaces them, as it always replaced a plan's texts
  const wroteTexts = built.days.map((d) => textKey(d.text));
  const keptTexts = [], lostTexts = [];
  const oldTexts = isDraft(cfg.plan) ? cfg.plan.draft.texts : cfg.plan?.texts;
  // a plan with no "texts" (one written before they were kept, or by hand), or a day it has none for (one added by
  // hand): a day's text is the command's own when it is a text this command writes for that day (its skeleton, or its
  // places' names), else the day's own words, kept and named the same way (planned again with no flag, a day's words
  // were replaced unseen)
  const placeOf = (ref) => sights.find((f) => f._layer === ref.layer && String(f.properties?.id) === String(ref.id)) || null;
  const wrote = (d, i) => (Array.isArray(oldTexts) && typeof oldTexts[i] === 'string' ? textKey(d.text) === oldTexts[i]
    : planWroteText(d, placeOf) || built.days.some((n) => n.title === d.title && n.text === d.text));
  if (cfg.plan && !args.force) {
    oldDays.forEach((d, i) => {
      if (typeof d?.text !== 'string' || !d.text.trim() || wrote(d, i)) return;
      const j = built.days.findIndex((n) => n.title === d.title);
      if (j >= 0) { built.days[j].text = d.text; keptTexts.push(j + 1); } else lostTexts.push({ n: i + 1, text: d.text });
    });
  }
  const textLines = [
    keptTexts.length ? `Day texts kept on their days (words written over the ${isDraft(cfg.plan) ? 'draft' : 'plan'}'s): ${keptTexts.map((n) => `day ${n}`).join(', ')}; check each still fits its places.` : null,
    lostTexts.length ? `Day texts of days this plan no longer has: ${lostTexts.map((x) => `day ${x.n} "${x.text}"`).join('; ')}. Put each on its day, or say it in the reply.` : null,
  ].filter(Boolean);
  // --sights: the ask is what to see each day, so validate fails while a full day has no sourced place, and in the turn
  // that planned the days while one has only one ("planned_at": a later turn keeps the days the person changed). A
  // --per-day of 1 is a person who asked for one place a day ("per_day")
  // the places of those layers on no day (no room on their stop's days, or far from every stop) are listed, so validate
  // tells them from a place pinned after the days were planned (a lookup still running then), which is on no day either
  const onPlan = new Set(built.days.flatMap((d) => d.items.map((it) => it.ref && `${it.ref.layer}:${it.ref.id}`)).filter(Boolean));
  const unplaced = sights.map((f) => `${f._layer}:${f.properties?.id}`).filter((r) => !onPlan.has(r));
  const request = refusal || again ? draftOf(args) : null;
  if (request) Object.assign(request, { inputs: inputsNow, texts: wroteTexts });
  // the days kept short (above), by their titles: uw validate warns of each, as this command does, and fails none
  const keptShort = keep ? short.map((x) => ({ title: String(x.day.title), places: x.have })) : [];
  // the days a later stop is reached after a short ride: one of its days to see once it has a place (stopDaysReport).
  // uw validate names one with nothing on it, as this command does, so the reply says the split
  const afterRide = sightLayers.length ? (built.stop_days || []).flatMap((r) => r.after_ride.filter((x) => x.full > 0).map((x) => ({ day: x.title, stop: r.name }))) : [];
  const plan = sightLayers.length ? { title: built.title, sights: sightLayers, ...(args['per-day'] != null ? { per_day: perDay } : {}), ...(unplaced.length ? { unplaced } : {}),
    ...(request ? { draft: request } : { texts: wroteTexts }), ...(keptShort.length ? { kept: keptShort.map((x) => x.title) } : {}),
    ...(afterRide.length ? { after_ride: afterRide } : {}), planned_at: new Date().toISOString(), days: built.days }
    : { title: built.title, texts: wroteTexts, days: built.days };
  cfg.plan = plan;
  // days in one place: the stop is the city the whole map shows, so the places list has no group for it (the Plan tab
  // names it), nor for the station `uw station` placed in it (a one-city map listed "Stations 1"); both stay on the
  // map. A trip of several stops lists them again
  const cmdOf = (id) => { try { return loadLayer(site, id, { required: false })?.uw?.cmd || null; } catch { return null; } };
  for (const def of (Array.isArray(cfg.layers) ? cfg.layers : []).filter((l) => l?.id && (l.id === stopLayer || (l.type === 'points' && cmdOf(l.id) === 'station')))) {
    if (stops.length === 1) def.list = false;
    else if (def.list === false) delete def.list;
  }
  writeJSON(site.cfgPath, cfg, { pretty: true });
  // nights per stop feature (summed over visits): the numbered stops show one dot per night
  if (args.nights) {
    const total = new Map();
    stops.forEach((s, i) => total.set(s.id, (total.get(s.id) || 0) + nights[i]));
    for (const f of sfc.features) if (total.has(String(f.properties.id))) f.properties.nights = total.get(String(f.properties.id));
    writeGeoJSON(layerPath(site, stopLayer), sfc);
  }
  site.config = cfg;
  // the first view frames the trip: its stops, the stays (the base) and the day places. `uw new` framed the city's
  // centre, and nothing framed the places after it, so a phone opened on the centre with the base at its edge. It
  // keeps every hand-picked layer `uw fit` frames too (a day trip, a marked airport the plan was not given): never
  // narrower than `uw fit`, or validate calls those places wrong matches
  const registered = new Set((cfg.layers || []).map((l) => l?.id));
  const { fitView, handPickedLayers } = await import('./cmd-site.mjs');
  const frame = [...new Set([stopLayer, args.stays, args.legs, ...sightLayers, ...handPickedLayers(site)])]
    .filter((id) => id && registered.has(id) && loadLayer(site, id, { required: false })?.features?.length);
  let view = null;
  if (frame.length) {
    try { view = (await fitView(site, { layers: frame.join(',') })).view; } catch (e) { out.warn(`could not frame the trip's places (${e.message}); run: uw fit ${args._[0]}`); }
  }
  if (refusal) {
    // what the refusal says, and that the days are on the map as they are for now (the days for a reply that cannot
    // wait: each short day named, "nothing to see yet" or with its one place)
    if (out.json) process.stdout.write(JSON.stringify({ ...refusal.json, draft: true, days_for_the_reply: daysForReply(plan), ...(keptTexts.length ? { kept_texts: keptTexts } : {}) }, null, 2) + '\n');
    console.error([...refusal.lines, ...(stopDays ? stopDays.lines : []), ...textLines].join('\n'));
    return 2;
  }
  const totalN = nights.reduce((a, b) => a + b, 0);
  const route = routeLine(stops, nights, plan, args.start);
  const forReply = replyLine(stops.length, route, plan, totalN);
  // what to see each day, as the map has it: the reply's days are these
  const daysLine = sightLayers.length ? daysForReply(plan) : '';
  const gaps = emptyPlanDays(plan);
  const drafted = plan.days.filter((d, i) => (i > 0 || plan.days.length === 1) && !SKELETON_DAY.test(String(d.text || '')) && !/^(Arrive in|Leave |Travel day)/.test(String(d.text || ''))).length;
  const feats = new Map([...[...legs, ...stays, ...sights].map((f) => [`${f._layer}:${f.properties?.id}`, f]), ...sfc.features.map((f) => [`${stopLayer}:${f.properties?.id}`, f])]);
  const misplaced = dayPlaceWarnings(plan, (r) => feats.get(`${r.layer}:${r.id}`) || null);
  // places that fit no day (more than --per-day of a layer on every day of their stop): say so, never drop them quietly;
  // a place the person named is never left out of the reply (it is off the plan only when the places they named fill
  // every day of its kind)
  const offPlan = [...poolSights(stops, sights).values()].flat().filter((f) => !onPlan.has(`${f._layer}:${f.properties?.id}`));
  const left = offPlan.filter((f) => f.properties?.asked !== true);
  // a place the person named on no day: no room (the places they named fill every day of its kind), or far from every
  // stop with no "stop" (no stop's days take it)
  const namedOff = sights.filter((f) => f.properties?.asked === true && !onPlan.has(`${f._layer}:${f.properties?.id}`));
  const far = (f) => !offPlan.includes(f);
  const nameOf = (f) => f.properties.name_en || f.properties.name || f.properties.id;
  // commands still running on this site (lib/running.mjs, read before the days were counted): what they find is not in
  // this plan yet
  const many = running.length > 1;
  const runningNext = running.length ? `Still running on this site: ${runningList(running)}. What ${many ? 'they find is' : 'it finds is'} not in this plan yet: `
    + `wait until ${many ? 'each has' : 'it has'} finished (an exit code; never start ${many ? 'one' : 'it'} again), then run this command again.` : null;
  out.result({ ok: true, days: plan.days.length, nights: totalN, route, for_the_reply: forReply, ...(daysLine ? { days_for_the_reply: daysLine } : {}), plan, ...(view ? { view } : {}), ...(misplaced.length ? { day_places: misplaced } : {}), ...(offPlan.length ? { not_on_plan: offPlan.map((f) => `${f._layer}:${f.properties.id}`) } : {}),
    ...(namedOff.length ? { named_not_on_plan: namedOff.map((f) => `${f._layer}:${f.properties.id}`) } : {}), ...(keptTexts.length ? { kept_texts: keptTexts } : {}),
    ...(keptShort.length ? { kept_short: keptShort } : {}), ...(stopDays ? { stop_days: stopDays.json } : {}),
    ...(running.length ? { still_running: running.map((r) => r.label), next: runningNext } : {}) }, [
    runningNext,
    `map.config.json: plan with ${plan.days.length} days (${totalN} nights) from ${args.start}: ` + plan.days.map((d) => d.title).slice(0, 4).join(' | ') + (plan.days.length > 4 ? ' | …' : ''),
    forReply,
    daysLine ? `Days for the reply, as the map has them (no other place; one not checked is said so): ${daysLine}.` : null,
    keptShort.length ? `Kept as ${keptShort.length === 1 ? 'it is' : 'they are'} (planned again with none to add): ${keptShort.map((x) => `${x.title} has one place to see`).join('; ')}. `
      + `Name ${keptShort.length === 1 ? 'that day' : 'each'} in the reply ("<day> has one place to see") and offer to add a place there; uw validate warns of ${keptShort.length === 1 ? 'it' : 'them'} too.` : null,
    ...(stopDays ? stopDays.lines : []),
    stays.length ? null : `No --stays: days focus on the ${stops.length === 1 ? 'stop' : 'stations'}. Run uw stay per stop, then this command again with --stays stays.`,
    !sightLayers.length ? 'No --sights: add 2-3 a full day (uw add-point … --layer sights --props-file - with {"stop":"<id>","source_url":"https://…","source":"…"}), then this command again with --sights sights.' : null,
    drafted ? `Day texts: ${drafted} full day(s) say what they are for, from their sourced places (names and the page's reason); keep them or reword them in the traveller's words (≤ 140 characters, nothing those pages do not say).` : null,
    gaps.empty ? `${gaps.empty} of ${gaps.full} full days still have no places ("Day in …", or only the arrival): add 2-3 sourced places for each of those days (reference/itinerary.md Phase B step 1), then this command again.` : null,
    ...misplaced.slice(0, 4).map((w) => `Day places: ${dayPlaceLine(w, plan.days)}.`),
    namedOff.length ? `Places the person named, on no day: ${namedOff.slice(0, 6).map((f) => `${nameOf(f)} (${far(f) ? 'far from every stop' : `each day already has --per-day ${perDay} places they named of its kind`})`).join(', ')}${namedOff.length > 6 ? ` and ${namedOff.length - 6} more` : ''}. `
      + `Never leave one out: ${[namedOff.some(far) && `give one far from every stop its stop (uw set ${args._[0]} <layer>:<id> --props '{"stop":"<its stop id>"}')`, namedOff.some((f) => !far(f)) && `run this command again with --per-day ${perDay + 1}`].filter(Boolean).join(', then ')}${namedOff.every(far) ? ', then run this command again' : ''}.` : null,
    left.length ? `Not on any day (each day already has --per-day ${perDay} of their kind): ${left.slice(0, 6).map(nameOf).join(', ')}${left.length > 6 ? ` and ${left.length - 6} more` : ''}. Add nights, raise --per-day, or leave them out of the reply.` : null,
    keptNotes.length ? `Day notes kept on their days: ${keptNotes.map((n) => `day ${n}`).join(', ')} (uw set ${args._[0]} plan:day<N> --note moves one).` : null,
    lostNotes.length ? `Day notes of days this plan no longer has: ${lostNotes.map((x) => `day ${x.n} "${x.note}"`).join('; ')}. Put each on its day (uw set ${args._[0]} plan:day<N> --note "…"), or say it in the reply.` : null,
    ...textLines,
    'Next: uw validate, then SKILL.md step 9 (refreshes the card). Never in the reply: file or folder names, commands or layer ids.',
  ]);
  return 0;
}
