// `transit`: scheduled train/bus connections between two points from a MOTIS journey planner (Transitous or a
// self-hosted MOTIS), so a trip leg gets a duration with a source instead of a guess. Disabled unless a planner is
// configured: Transitous only allows open-source, non-commercial use, so a hosted product needs its own MOTIS or a
// licensed planner (data-sources.md). Points come from the site (stations:taipei) or from geocode output.
import { parseArgs, makeOut, need, UsageError, UserError, skipped } from './util.mjs';
import { transitLookup } from './route-lookups.mjs';
import { primaryOf } from './net.mjs';
import { openSite, resolvePoint } from './site.mjs';

export const help = `transit [<site>] --from <layer:id | lng,lat> --to <layer:id | lng,lat> --date YYYY-MM-DD [--modes rail|transit]
        [--count 3] [--endpoint <MOTIS base URL>] [--json]
  Scheduled connections from a MOTIS journey planner: per option the local departure and arrival, ride time
  (first boarding to last alighting), transfers, trains and operator; plus a typical duration_min (median), the
  source_url (the reproducible planner query) and retrieved_at. Use it for a leg's --durations with
  --source "<operator> timetable via <planner>" --source-url <that url>, or a handoff leg's duration_min.
  The planner is --endpoint or UW_TRANSIT_URL (e.g. a self-hosted MOTIS). Transitous (https://api.transitous.org) is
  for open-source, non-commercial use only. None configured = exit 4 (skipped): keep "check the timetable" links.
  --modes rail (default: trains only) or transit (trains, buses, ferries). Searches departures from about 08:00 local
  time at the origin on that date (the offset is estimated from its longitude, so New York searches its morning, not
  the evening before); times are printed in the station's local time.`;

/** Departures are searched from about 08:00 local time at the origin: UTC = 08:00 − round(lng / 15) h. Without a time
 *  zone database this is the solar offset, within an hour or two of the legal one, which keeps the search in the
 *  traveller's morning anywhere (00:00 UTC is the previous evening in the Americas). Exported for the tests. */
export function searchStartIso(date, lng, hour = 8) {
  const offset = Math.round(Math.max(-180, Math.min(180, Number(lng) || 0)) / 15);
  const t = Date.parse(`${date}T00:00:00Z`) + (hour - offset) * 3600e3;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const fmtLocal = (iso, tz) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  } catch { return iso; }
};

/** MOTIS /api/v5/plan answer → options + typical ride time. Exported for the tests. */
export function summarisePlan(plan, { count = 3 } = {}) {
  const options = [];
  for (const it of plan?.itineraries || []) {
    const rides = (it.legs || []).filter((l) => l.mode && !/^(WALK|BIKE|CAR|FLEX|ODM)/.test(l.mode));
    if (!rides.length) continue;
    const first = rides[0], last = rides[rides.length - 1];
    const minutes = Math.round((Date.parse(last.endTime) - Date.parse(first.startTime)) / 60000);
    if (!(minutes > 0)) continue;
    const tz = first.from?.tz;
    options.push({
      depart_local: fmtLocal(first.startTime, tz),
      arrive_local: fmtLocal(last.endTime, last.to?.tz || tz),
      duration_min: minutes,
      transfers: rides.length - 1,
      rides: rides.map((l) => `${l.from?.name || '?'} → ${l.to?.name || '?'}${l.displayName || l.routeShortName || l.tripShortName ? ` (${[l.displayName || l.routeShortName, l.tripShortName].filter(Boolean).join(' ')})` : ''}`),
      operators: [...new Set(rides.map((l) => l.agencyName).filter(Boolean))],
      start: first.startTime,
    });
  }
  options.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const picked = options.slice(0, Math.max(1, count));
  const d = picked.map((o) => o.duration_min).sort((a, b) => a - b);
  const median = d.length ? d[Math.floor((d.length - 1) / 2)] : null;
  return { options: picked, duration_min: median, operators: [...new Set(picked.flatMap((o) => o.operators))] };
}

export async function run(argv) {
  const args = parseArgs(argv, { from: 'string', to: 'string', date: 'string', modes: 'string', count: 'number', endpoint: 'string' },
    { positionals: [0, 1], command: 'transit' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  need(args, 'from', 'a stop ref like stations:taipei (with the site) or lng,lat from geocode');
  need(args, 'to');
  need(args, 'date', 'the travel day, YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date) || Number.isNaN(Date.parse(`${args.date}T00:00:00Z`))) throw new UsageError(`--date "${args.date}" must be YYYY-MM-DD`);
  const modes = (args.modes || 'rail').toLowerCase();
  if (!['rail', 'transit'].includes(modes)) throw new UsageError('--modes is rail or transit');
  // the planner: --endpoint, else the transit chain's declared one (UW_TRANSIT_URL / INSTAFY_LOOKUP_PROVIDERS)
  const base = (args.endpoint || primaryOf('transit')?.base || '').trim().replace(/\/+$/, '');
  if (!base) throw skipped('no journey planner is configured (UW_TRANSIT_URL or --endpoint); leave the leg without a duration and link the operator timetable');
  let baseUrl;
  try { baseUrl = new URL(base); } catch { throw new UsageError(`--endpoint "${base}" is not a URL`); }
  if (baseUrl.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(baseUrl.hostname)) throw new UsageError('the planner endpoint must be https');
  const site = args._[0] ? openSite(args._[0]) : null;
  const from = resolvePoint(site, args.from, 'from');
  const to = resolvePoint(site, args.to, 'to');

  const { plan, url } = await transitLookup({
    fromPlace: `${from.coord[1]},${from.coord[0]}`, toPlace: `${to.coord[1]},${to.coord[0]}`, time: searchStartIso(args.date, from.coord[0]),
    numItineraries: String(Math.max(1, Math.min(6, args.count ?? 3))), ...(modes === 'rail' ? { transitModes: 'RAIL' } : {}),
  }, { base: args.endpoint ? base : null });
  const q = new URL(url);
  const s = summarisePlan(plan, { count: args.count ?? 3 });
  const retrieved = new Date().toISOString().slice(0, 10);
  const planner = /transitous/i.test(baseUrl.host) ? 'Transitous' : baseUrl.host;
  const source = `${s.operators.join(', ') || 'operator'} timetable via ${planner}`;
  if (!s.options.length) {
    out.result({ ok: false, from: from.name, to: to.name, date: args.date, source_url: q.toString(), retrieved_at: retrieved, options: [] },
      [`No scheduled ${modes === 'rail' ? 'train' : 'transit'} connection found ${from.name} → ${to.name} on ${args.date}. Keep the leg without a duration.`]);
    return 1;
  }
  out.result({ ok: true, from: from.name, to: to.name, date: args.date, duration_min: s.duration_min, operators: s.operators, source, source_url: q.toString(),
    retrieved_at: retrieved, options: s.options.map(({ start, ...o }) => o) }, [
    `${from.name} → ${to.name}, ${args.date}: typically ${s.duration_min} min (${s.options.length} option${s.options.length === 1 ? '' : 's'})`,
    ...s.options.map((o) => `  ${o.depart_local} → ${o.arrive_local}  ${o.duration_min} min, ${o.transfers ? `${o.transfers} change${o.transfers === 1 ? '' : 's'}` : 'direct'}: ${o.rides.join(' · ')}`),
    `source: ${source} · retrieved_at ${retrieved}`,
    `source_url: ${q.toString()}`,
    'Times are scheduled, not live; say "about" and keep the operator timetable link.',
  ]);
  return 0;
}
