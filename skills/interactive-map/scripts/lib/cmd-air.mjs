// `air`: Open-Meteo air quality (CAMS) → data/air.json.
//
// Output shape (data/air.json; the engine's air chip reads it and follows the time slider via by_hour):
// {
//   "source": "Open-Meteo Air Quality API (CAMS)",
//   "attribution": "Air quality: Open-Meteo.com / Copernicus Atmosphere Monitoring Service (CAMS)",
//   "generated_at": "2026-10-11T09:00:00.000Z",
//   "timezone": "Asia/Taipei", "utc_offset_seconds": 28800,
//   "units": { "pm2_5": "μg/m³", "pm10": "μg/m³", "nitrogen_dioxide": "μg/m³", "european_aqi": "EAQI", "us_aqi": "USAQI" },
//   "note": "Regional model values (~10-40 km grid), not street-level measurements.",
//   "locations": [{
//     "id": "via-loft", "name": "Via Loft", "lng": 121.52, "lat": 25.05,      // id = source feature id or "here"
//     "model_lng": 121.5, "model_lat": 25.1,                                     // grid cell the model used
//     "hourly": { "time": ["2026-10-04T00:00", …local time…], "pm2_5": [..], "pm10": [..], "nitrogen_dioxide": [..],
//                 "european_aqi": [..], "us_aqi": [..] },                        // past 7 days + 3 forecast days
//     "by_hour": { "0": { "pm2_5": 11.2, "pm10": 19.0, "nitrogen_dioxide": 14.1, "european_aqi": 28, "us_aqi": 46 }, … "23": {…} },
//                                                                                // hour-of-day (local) averages over all days
//     "current": { "time": "2026-10-11T17:00", "pm2_5": 9.8, …, "us_aqi": 41, "category": "Good" },
//     "summary": { "pm2_5_avg": 12.3, "us_aqi_avg": 48, "category": "Good", "worst_hour": 8, "best_hour": 3 }
//   }]
// }
import { parseArgs, makeOut, parseLngLat, writeJSON, round6, UsageError, UserError } from './util.mjs';
import { airLookup } from './route-lookups.mjs';
import { openSite, loadLayer, resolvePoint, ensureConfigKey } from './site.mjs';
import path from 'node:path';

export const help = `air <dir> (--at lng,lat [--name "Taipei"] | --from layer:<layerId> | --from <layer>:<id>) [--out data/air.json] [--json]
  Open-Meteo air quality (pm2_5, pm10, nitrogen_dioxide, european_aqi, us_aqi; past 7 + next 3 days, hourly) →
  data/air.json with hour-of-day averages (by_hour) per location, plus current values. Regional model data (CAMS):
  label it "regional", not street level. Max 25 locations (one request). Adds to map.config.json (if absent): "air": { "enabled": true, "data": "data/air.json" }`;

const VARS = ['pm2_5', 'pm10', 'nitrogen_dioxide', 'european_aqi', 'us_aqi'];

export function usAqiCategory(v) {
  if (v == null) return null;
  return v <= 50 ? 'Good' : v <= 100 ? 'Moderate' : v <= 150 ? 'Unhealthy for sensitive groups' : v <= 200 ? 'Unhealthy' : v <= 300 ? 'Very unhealthy' : 'Hazardous';
}

export async function run(argv) {
  const args = parseArgs(argv, { at: 'string', from: 'string', name: 'string', out: 'string', force: 'bool' }, { positionals: [1, 1], command: 'air' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  if (!args.at && !args.from) throw new UsageError('air needs --at lng,lat or --from layer:<layerId>');
  let locs = [];
  if (args.at) {
    const c = parseLngLat(args.at, 'at');
    locs.push({ id: 'here', name: args.name || 'Here', coord: c });
  }
  if (args.from) {
    const m = args.from.match(/^layer:([^:]+)$/);
    if (m) {
      const fc = loadLayer(site, m[1]);
      for (const f of fc.features) {
        if (f?.properties?.id == null) continue;
        const r = resolvePoint(site, `${m[1]}:${f.properties.id}`, 'from');
        locs.push({ id: String(f.properties.id), name: f.properties.name_en || f.properties.name || f.properties.id, coord: r.coord });
      }
    } else {
      const r = resolvePoint(site, args.from, 'from');
      locs.push({ id: r.id || 'here', name: r.feature?.properties?.name_en || r.name, coord: r.coord });
    }
  }
  if (!locs.length) throw new UserError('no locations to query');
  if (locs.length > 25) throw new UsageError(`${locs.length} locations; max 25 per run. Air data is regional, so a few representative points are enough.`);

  out.log(`Fetching air quality for ${locs.length} location(s)…`);
  let { data } = await airLookup({
    latitude: locs.map((l) => l.coord[1].toFixed(4)).join(','), longitude: locs.map((l) => l.coord[0].toFixed(4)).join(','),
    hourly: VARS.join(','), past_days: '7', forecast_days: '3', timezone: 'auto',
  }, { cacheMaxAgeMs: 3 * 3600e3 });
  if (!Array.isArray(data)) data = [data];
  if (data.length !== locs.length) throw new UserError(`Open-Meteo returned ${data.length} results for ${locs.length} locations`);
  if (data[0]?.error) throw new UserError(`Open-Meteo: ${data[0].reason || 'error'}`);

  const nowUtc = Date.now();
  // CAMS Europe (0.1°) covers roughly 30-72°N, 25°W-45°E; elsewhere Open-Meteo uses CAMS global (0.4°)
  const europe = locs.every((l) => l.coord[1] >= 30 && l.coord[1] <= 72 && l.coord[0] >= -25 && l.coord[0] <= 45);
  const locations = locs.map((l, i) => {
    const d = data[i];
    const h = d.hourly || {};
    const hourly = { time: h.time || [] };
    for (const v of VARS) hourly[v] = (h[v] || []).map((x) => (x == null ? null : Math.round(x * 10) / 10));
    // hour-of-day averages
    const sums = {}, counts = {};
    hourly.time.forEach((t, k) => {
      const hr = Number(t.slice(11, 13));
      for (const v of VARS) {
        const x = hourly[v][k];
        if (x == null) continue;
        const key = `${hr}|${v}`;
        sums[key] = (sums[key] || 0) + x; counts[key] = (counts[key] || 0) + 1;
      }
    });
    const by_hour = {};
    for (let hr = 0; hr < 24; hr++) {
      const o = {};
      for (const v of VARS) {
        const key = `${hr}|${v}`;
        o[v] = counts[key] ? (/aqi/.test(v) ? Math.round(sums[key] / counts[key]) : Math.round((sums[key] / counts[key]) * 10) / 10) : null;
      }
      by_hour[hr] = o;
    }
    // current: hourly entry for the current local hour
    const localNow = new Date(nowUtc + (d.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 13) + ':00';
    let k = hourly.time.indexOf(localNow);
    if (k < 0) k = hourly.time.length - 1;
    const current = { time: hourly.time[k] };
    for (const v of VARS) current[v] = hourly[v][k] ?? null;
    current.category = usAqiCategory(current.us_aqi);
    const vals = (v) => hourly[v].filter((x) => x != null);
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const hrs = Object.entries(by_hour).filter(([, o]) => o.us_aqi != null).sort((a, b) => a[1].us_aqi - b[1].us_aqi);
    const usAvg = avg(vals('us_aqi'));
    const summary = {
      pm2_5_avg: avg(vals('pm2_5')) == null ? null : Math.round(avg(vals('pm2_5')) * 10) / 10,
      us_aqi_avg: usAvg == null ? null : Math.round(usAvg),
      category: usAqiCategory(usAvg == null ? null : Math.round(usAvg)),
      best_hour: hrs.length ? Number(hrs[0][0]) : null,
      worst_hour: hrs.length ? Number(hrs[hrs.length - 1][0]) : null,
    };
    return { id: l.id, name: l.name, lng: round6(l.coord[0]), lat: round6(l.coord[1]), model_lng: d.longitude, model_lat: d.latitude, hourly, by_hour, current, summary };
  });
  const year = new Date().getUTCFullYear();
  const t0 = locations[0]?.hourly?.time?.[0], t1 = locations[0]?.hourly?.time?.at(-1);
  const doc = {
    source: 'Open-Meteo Air Quality API (CAMS)',
    attribution: `Air: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0) · Contains modified Copernicus Atmosphere Monitoring Service information ${year}`,
    // required by the CAMS licence wherever the data is shown; the engine puts it in the air toast and the sources list
    disclaimer: 'Neither the European Commission nor ECMWF is responsible for any use of this information.',
    window: t0 && t1 ? { from: t0.slice(0, 10), to: t1.slice(0, 10) } : undefined,
    kind: 'model',
    resolution_km: europe ? 11 : 45,
    generated_at: new Date().toISOString(),
    timezone: data[0].timezone, utc_offset_seconds: data[0].utc_offset_seconds,
    units: data[0].hourly_units ? Object.fromEntries(VARS.map((v) => [v, data[0].hourly_units[v]])) : undefined,
    note: `Regional model values (CAMS ${europe ? 'Europe ~11 km' : 'global ~45 km'} grid), not street-level measurements.`,
    locations,
  };
  const rel = args.out || site.config?.air?.data || 'data/air.json';
  const file = path.resolve(site.dir, rel);
  if (!file.startsWith(site.dir + path.sep)) throw new UsageError('--out must be inside the site directory');
  writeJSON(file, doc);
  const relOut = path.relative(site.dir, file).split(path.sep).join('/');
  const configured = !!site.config?.air;
  const airNote = configured ? null : ensureConfigKey(site, 'air', { enabled: true, data: relOut });
  // say plainly what the numbers can and cannot tell apart
  const cells = new Set(locations.map((l) => `${l.model_lng},${l.model_lat}`));
  const notes = [];
  if (locations.length > 1 && cells.size < locations.length)
    notes.push(`${locations.length - cells.size + 1 === locations.length ? `All ${locations.length}` : `${locations.length - cells.size + 1}`} locations share one model cell (~${doc.resolution_km} km): air will not tell them apart. Say so, or use one location.`);
  if (doc.window) notes.push(`Values are hour-of-day averages for ${doc.window.from} to ${doc.window.to} (the past week + 3-day forecast), not the user's travel dates.`);
  out.result({ ok: true, file: relOut, notes, locations: locations.map((l) => ({ id: l.id, name: l.name, current: l.current, summary: l.summary })),
    added_to_config: configured ? null : { air: { enabled: true, data: relOut } } }, [
    `Wrote ${relOut}: ` + locations.map((l) => `${l.name}: now PM2.5 ${l.current.pm2_5 ?? '?'} · US AQI ${l.current.us_aqi ?? '?'} (${l.current.category || '?'}), 10-day avg AQI ${l.summary.us_aqi_avg ?? '?'}`).join('; '),
    ...notes,
    airNote ? `${airNote} The engine adds the Open-Meteo / CAMS credit and disclaimer from the file.` : null,
  ]);
}
