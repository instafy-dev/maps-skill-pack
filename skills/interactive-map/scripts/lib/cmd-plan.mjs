// `plan`: the day-by-day "plan" block of a trip, built from what the commands already wrote (stops with nights, legs,
// stays, sights), so dates, nights and travel days add up and every item points at a real feature. A trip may have
// one stop: days in one place, each day a loop from the same base. The agent then adds one sourced line of text per
// day; it never has to type the skeleton (or a date) by hand.
import fs from 'node:fs';
import { parseArgs, makeOut, parseList, readJSON, writeJSON, writeGeoJSON, haversine, representativePoint, clipWords, UsageError, UserError } from './util.mjs';
import { openSite, loadLayer, layerPath, checkLayerId } from './site.mjs';

export const help = `plan <dir> --stops <layer> --start YYYY-MM-DD [--ids taipei,hualien,…,taipei] [--nights 3,2,2,3,2,2]
     [--legs trip] [--stays stays] [--sights sights[,food,daytrips]] [--per-day 3] [--title "Plan"] [--force] [--json]
  Writes map.config.json "plan": one day per date from --start, nights per stop in travel order, a travel day per leg.
  --ids: the stops in travel order (a loop names its first stop again at the end); default: the layer's order. One
  stop is a stay in one place ("3 days in Lisbon": --ids lisbon --nights 3): its days are loops from the same base,
  no travel day. A stop named twice in a row is one stay (its nights add up), never a travel day to itself.
  --nights: one number per --ids entry (the last stop of a loop may be 0 = fly out the day you arrive; one stop with
  0 nights is a single day there); default: each stop feature's "nights". With --nights the stop features' "nights"
  become the total per stop (dots under the name).
  Each day: title "Tue 20 Oct · Hualien" (travel days "Fri 23 Oct · Taipei → Hualien"), a lighting hour
  ("time" with "time_hint": true, never shown as a clock time), focus (the stop's
  rank-1 stay from --stays, else the stop), items: the leg (with its sourced duration, or "check the timetable"),
  the base ("Base: <stay> · 4 min walk to <station>"), and up to --per-day places per layer from --sights (features
  with "stop" = the stop id, else the nearest stop within 60 km; an item copies the feature's source_url/source as its
  link; --sights may list several layers, e.g. sights,food,daytrips). A stop's places are grouped by area: the
  closest ones share a day, each day's in walking order from the base (a loop), the area nearest the base first; the
  first day of the trip takes an area too when the full days would hold more than 2 places each. A full day that gets sourced
  places gets a text from them instead of "Day in …": their names, the first with its "why" (the reason its page
  gives), ≤ 140 characters. The day after the last night is the departure ("depart": true, "Leave <stop>."): nothing
  is planned on it. Prints a warning for a place that is far from its day's other places or closer to another day's
  (plan-checks.json). Refuses to replace an existing plan without --force. Days with no sourced place keep "Day in …":
  add places.`;

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

/** Full days (a whole day at a stop, not travel) still as `uw plan` wrote them: no items and the skeleton text; and
 *  thin ones: fewer than two sourced items (a day with one city-page sight is not "2-3 per city" yet).
 *  Pure; used by validate and the turn clock to say "add sights" while there is time. */
export function emptyPlanDays(plan) {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const full = days.filter((d, i) => (i > 0 || days.length === 1) && !String(d?.title || '').includes('→') && !isDepartDay(d));
  const empty = full.filter((d) => (!Array.isArray(d.items) || d.items.length === 0) && SKELETON_DAY.test(String(d.text || '')));
  const sourced = (d) => (Array.isArray(d.items) ? d.items : []).filter((it) => typeof it?.url === 'string' && /^https?:\/\//.test(it.url) && !/^Base: /.test(String(it.text || ''))).length;
  const thin = full.filter((d) => sourced(d) < 2);
  return { empty: empty.length, thin: thin.length, full: full.length, days: days.length };
}

/** The route with nights and dates, one line, for the reply ("Taipei 3 → Hualien 2 → … (Tue 20 Oct – Tue 3 Nov)"):
 *  the night split is an assumption the traveller must see. Pure; exported for the tests. */
export function routeLine(stops, nights, plan) {
  const parts = stops.map((s, i) => (nights[i] > 0 ? `${cityOf(s.props)} ${nights[i]}` : null)).filter(Boolean);
  const days = plan?.days || [];
  const first = days[0]?.title?.split(' · ')[0];
  const last = days[days.length - 1]?.title?.split(' · ')[0];
  const total = nights.reduce((a, b) => a + b, 0);
  const when = first && last ? (first === last ? first : `${first} – ${last}`) : '';
  return `${parts.join(' → ') || cityOf(stops[0]?.props)} (${total} night${total === 1 ? '' : 's'}${when ? `, ${when}` : ''})`;
}

/** The stops in travel order with a stop named twice in a row merged into one stay (its nights added up): "Lisbon →
 *  Lisbon" is not a travel day. Pure; exported for the tests. */
export function collapseStops(stops, nights) {
  const s = [], n = [];
  stops.forEach((x, i) => {
    if (s.length && s[s.length - 1].id === x.id) n[n.length - 1] += nights[i];
    else { s.push(x); n.push(nights[i]); }
  });
  return { stops: s, nights: n };
}

const pointOf = (f) => (f?.geometry ? representativePoint(f.geometry) : null);
const km = (a, b) => (a && b ? haversine(a, b) / 1000 : Infinity);

/** The places of one stay split into at most `k` days by where they are: two groups merge while their farthest pair
 *  of places is the closest of any two groups (so a day never spans two areas when another split exists), never past
 *  `perDay` places of one layer. Places closer than `sameAreaKm` count as one area: there the smaller groups merge
 *  first, so the days share an area's places evenly. Fewer places than days: one each (spread, as before). Places that
 *  fit no day stay off the plan. Pure; exported for the tests. */
export function groupByArea(feats, k, perDay = 3, sameAreaKm = planChecks().same_area_km) {
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
  for (const g of groups.slice(k)) for (const i of g) {
    let best = null;
    for (const h of kept) {
      if (!fits(h, [i])) continue;
      const l = Math.min(...h.map((j) => d(i, j)));
      if (!best || l < best.l) best = { h, l };
    }
    if (best) best.h.push(i);
  }
  return kept.map((g) => g.sort((a, b) => a - b).map((i) => feats[i]));
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
  return { same_area_km: 1.5, first_day_over: 2, near_km: 1.5, closer_ratio: 2, far_km: 4, trip_out_km: 15, ...CHECKS, ...over };
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
  const mode = String(lp.mode || 'train').toLowerCase();
  const kmh = LEG_KMH[mode];
  const routed = Number(lp.distance_km) > 0 ? Number(lp.distance_km) : null;
  const straight = a?.coord && b?.coord ? haversine(a.coord, b.coord) / 1000 : null;
  const dist = routed ?? (straight != null ? straight * (mode === 'flight' ? 1 : 1.25) : null);
  if (!kmh || !dist || dist < 1) return ' · times: check the timetable';
  const min = (dist / kmh) * 60;
  const about = min < 55 ? `${Math.max(10, Math.round(min / 10) * 10)} min` : `${Math.round(min / 30) / 2} h`;
  const by = mode === 'hsr' ? 'high-speed train' : mode === 'car' ? 'car' : mode;
  return ` · about ${about} by ${by} (estimate from ${Math.round(dist)} km; check the timetable)`;
}

/** Build the plan days. Pure (exported for the tests). */
export function buildPlan({ stops: stopsIn, nights: nightsIn, start, legs = [], stays = [], sights = [], perDay = 3, title = 'Plan' }) {
  if (stopsIn.length !== nightsIn.length) throw new UsageError(`--nights has ${nightsIn.length} values for ${stopsIn.length} stops`);
  if (!stopsIn.length) throw new UsageError('a plan needs at least one stop');
  const { stops, nights } = collapseStops(stopsIn, nightsIn);
  const days = [];
  const date = new Date(`${start}T00:00:00Z`);
  const next = () => { const d = new Date(date); date.setUTCDate(date.getUTCDate() + 1); return d; };
  const legFor = (a, b, i) => legs.find((f) => f.properties.order === i + 1 && (f.properties.from === a.id || f.properties.from_id === a.id))
    || legs.find((f) => (f.properties.from === a.id) && (f.properties.to === b.id));
  // a stay the research team picked (with its reason and source) is the base; then the ranked picks
  const stayFor = (s) => stays.filter((f) => f.properties.stop === s.id)
    .sort((x, y) => (y.properties.researched ? 1 : 0) - (x.properties.researched ? 1 : 0) || (x.properties.rank ?? 9) - (y.properties.rank ?? 9))[0] || null;
  // where a stop's days start and end: its base stay (when it is near the stop), else the stop itself
  const baseOf = (s) => { const c = pointOf(stayFor(s)); return c && km(c, s.coord) < 60 ? c : s.coord || c || null; };
  // sights per stop: explicit "stop", else the nearest stop within 60 km
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
  const sightItem = (f) => {
    const p = f.properties;
    return { text: p.name_en || p.name, ref: { layer: f._layer, id: p.id }, ...(p.source_url ? { url: p.source_url } : {}), ...(p.source && p.source_url ? { source: String(p.source).slice(0, 40) } : {}) };
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
  const visits = []; // per stop visit: { stop, arrive: day, full: [days], first }
  let carry = null; // a travel day that goes on through a 0-night stop (A → B → C on one date)
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i], n = nights[i];
    const city = cityOf(s.props);
    const visit = { stop: s.id, s, arrive: null, full: [], first: i === 0 };
    if (i === 0 && n === 0 && stops.length === 1) {
      // one day in one place
      visit.arrive = { title: `${fmtDay(next())} · ${city}`, time: 10, time_hint: true, focus: focusOf(s), text: `Day in ${city}.`, items: [] };
      days.push(visit.arrive);
      visits.push(visit);
      continue;
    }
    if (i === 0) {
      visit.arrive = { title: `${fmtDay(next())} · ${city}`, time: 15, time_hint: true, focus: focusOf(s), text: `Arrive in ${city}; night 1 of ${n}.`, items: [baseItem(s)].filter(Boolean) };
      days.push(visit.arrive);
    } else visit.arrive = days[days.length - 1];
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
      else days.push(carry = { title: `${fmtDay(next())} · ${city} → ${bCity}`, time: 9, time_hint: true, focus: focusOf(b), text, items });
      if (!through) carry = null;
    } else if (n > 0) {
      // the day after the last night: the traveller leaves; nothing is planned on it, and the plan says so
      days.push({ title: `${fmtDay(next())} · ${city}: depart`, time: 9, time_hint: true, focus: focusOf(s), text: `Leave ${city}.`, depart: true, items: [] });
    }
  }
  // pass 2: a stop's places go on its full days grouped by area (≤ perDay of a layer each), each day in walking order
  // from the base, the area nearest the base first. The trip's first day (an arrival with no travel before it) takes
  // an area too when the full days would hold more than plan-checks.json's first_day_over places each; a stop with no
  // full day gets them on its arrival day. A stop visited twice shares its places across both visits.
  const used = new Set();
  const placedOn = new Map(); // day → the sight features placed on it (for its text)
  for (const v of visits) {
    const visitsOfStop = visits.filter((x) => x.stop === v.stop).length;
    const share = Math.ceil((pool.get(v.stop) || []).length / visitsOfStop);
    const mine = (pool.get(v.stop) || []).filter((f) => !used.has(f.properties.id)).slice(0, share);
    if (!mine.length) continue;
    const base = baseOf(v.s);
    let slots = v.full.length ? [...v.full] : [v.arrive];
    if (v.full.length && v.first && mine.length > v.full.length * planChecks().first_day_over) slots = [v.arrive, ...v.full];
    const centre = (g) => { const c = g.map(pointOf).filter(Boolean); return c.length ? [c.reduce((a, x) => a + x[0], 0) / c.length, c.reduce((a, x) => a + x[1], 0) / c.length] : null; };
    const groups = groupByArea(mine, slots.length, perDay)
      .map((g) => ({ g, d: base ? km(base, centre(g)) : 0 })).sort((a, b) => a.d - b.d).map((x) => x.g);
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
    else if (/^Arrive in .+; night 1 of \d+\.$/.test(String(d.text || ''))) {
      const more = `${d.text} Then: ${dayTextFrom(sourced, 140 - d.text.length - 7)}`;
      if (more.length <= 140 && !/Then: $/.test(more)) d.text = more;
    }
  }
  return { title, days };
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

export async function run(argv) {
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
  const perDay = args['per-day'] ?? 3;
  const withLayer = (id) => { if (!id) return []; const fc = loadLayer(site, checkLayerId(id), { required: false }); return (fc?.features || []).map((f) => Object.assign(f, { _layer: id })); };
  // --sights takes several layers (sights,food,daytrips): every sourced place a lane or a follow-up pinned
  const legs = withLayer(args.legs), stays = withLayer(args.stays), sights = parseList(args.sights || '').flatMap((id) => withLayer(id));
  const cfg = readJSON(site.cfgPath);
  if (cfg.plan && !args.force) throw new UserError('map.config.json already has a "plan"; pass --force to rebuild it (hand-written day texts are replaced)');
  const plan = buildPlan({ stops, nights, start: args.start, legs, stays, sights, perDay, title: args.title || 'Plan' });
  cfg.plan = plan;
  writeJSON(site.cfgPath, cfg, { pretty: true });
  // nights per stop feature (summed over visits): the numbered stops show one dot per night
  if (args.nights) {
    const total = new Map();
    stops.forEach((s, i) => total.set(s.id, (total.get(s.id) || 0) + nights[i]));
    for (const f of sfc.features) if (total.has(String(f.properties.id))) f.properties.nights = total.get(String(f.properties.id));
    writeGeoJSON(layerPath(site, stopLayer), sfc);
  }
  const totalN = nights.reduce((a, b) => a + b, 0);
  const sightsOf = (s) => sights.filter((f) => f.properties.stop === s.id).length;
  const missingSights = stops.filter((s, i) => nights[i] >= 2 && sightsOf(s) < 2).map((s) => `${cityOf(s.props)} (${sightsOf(s)})`);
  const route = routeLine(stops, nights, plan);
  const gaps = emptyPlanDays(plan);
  const drafted = plan.days.filter((d, i) => i > 0 && !SKELETON_DAY.test(String(d.text || '')) && !/^(Arrive in|Leave |Travel day)/.test(String(d.text || ''))).length;
  const feats = new Map([...[...legs, ...stays, ...sights].map((f) => [`${f._layer}:${f.properties?.id}`, f]), ...sfc.features.map((f) => [`${stopLayer}:${f.properties?.id}`, f])]);
  const misplaced = dayPlaceWarnings(plan, (r) => feats.get(`${r.layer}:${r.id}`) || null);
  out.result({ ok: true, days: plan.days.length, nights: totalN, route, plan, ...(misplaced.length ? { day_places: misplaced } : {}) }, [
    `map.config.json: plan with ${plan.days.length} days (${totalN} nights) from ${args.start}: ` + plan.days.map((d) => d.title).slice(0, 4).join(' | ') + (plan.days.length > 4 ? ' | …' : ''),
    `${stops.length === 1 ? 'Stay' : 'Route'} for the reply (say the night split; it is an assumption unless the user fixed it): ${route}`,
    stays.length ? null : `No --stays: days focus on the ${stops.length === 1 ? 'stop' : 'stations'}. Run uw stay per stop, then re-run plan --force.`,
    sights.length && missingSights.length ? `Fewer than 2 sights with "stop" for: ${[...new Set(missingSights)].join(', ')} (add 2-3 sourced ones per ${stops.length === 1 ? 'day' : 'city'}).` : null,
    !sights.length ? 'No --sights: add 2-3 per city (uw add-point … --layer sights --props \'{"stop":"<id>","source_url":"https://…","source":"…"}\'), then re-run with --sights sights --force.' : null,
    drafted ? `Day texts: ${drafted} full day(s) say what they are for, from their sourced places (names and the page's reason); keep them or reword them in the traveller's words (≤ 140 characters, nothing those pages do not say).` : null,
    gaps.empty ? `${gaps.empty} of ${gaps.full} full days still say "Day in …": add 2-3 sourced places for those stops (reference/itinerary.md Phase B step 1), then this command again with --force.` : null,
    ...misplaced.slice(0, 4).map((w) => `Day places: ${dayPlaceLine(w, plan.days)}.`),
    'Next: uw validate, then the preview card. Never in the reply: file or folder names, commands or layer ids.',
  ]);
  return 0;
}
