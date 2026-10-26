// `doorstep`: the street at each item's door (lane / street / main road), the distance to the nearest main road, and a
// Street View camera point + heading so link-outs open looking AT the door. ENGINE-SPEC-v0.2 §7.1.
import path from 'node:path';
import { parseArgs, makeOut, writeGeoJSON, representativePoint, haversine, round6, UsageError, UserError } from './util.mjs';
import { overpass } from './net.mjs';
import { openSite, checkLayerId, loadLayer, layerPath } from './site.mjs';
import { nearestOnLine, bearing } from './geo.mjs';
import { mergeMetrics } from './metrics.mjs';

export const help = `doorstep <dir> --layer hotels [--max-dist 60] [--json]
  One Overpass query for the streets around every feature of --layer. Per feature it writes (in place):
    sv_viewpoint [lng,lat]  nearest point on the nearest street (≤ --max-dist m; footways only when nothing else)
    sv_heading              bearing from that point to the door ("entrance" [lng,lat] if set, else the feature point);
                            omitted when the point sits on the street itself (< 3 m)
    street_name, street_name_local, street_class   lane (residential, living_street, service, pedestrian) | street |
                            main (primary, secondary, trunk)
    main_road_m             straight-line distance to the nearest primary/secondary/trunk road (≤ 600 m searched)
  and metrics.json entries for main_road_m (basis counted) and street_class (display only). The engine builds the
  Street View / Look Around link-outs from sv_viewpoint + sv_heading.`;

const MAIN = ['primary', 'secondary', 'trunk'];
const CAND = ['residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'service', 'pedestrian',
  'primary_link', 'secondary_link', 'tertiary_link', 'trunk_link'];
const FOOT = ['footway', 'path', 'steps', 'cycleway', 'corridor'];
const classOf = (hw) => (['residential', 'living_street', 'service', 'pedestrian'].includes(hw) ? 'lane' : MAIN.includes(hw.replace(/_link$/, '')) ? 'main' : 'street');

export async function run(argv) {
  const args = parseArgs(argv, { layer: 'string', 'max-dist': 'number' }, { positionals: [1, 1], command: 'doorstep' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  const maxDist = args['max-dist'] ?? 60;
  if (maxDist < 5 || maxDist > 200) throw new UsageError('--max-dist must be 5-200 m');
  const fc = loadLayer(site, layer);
  const feats = fc.features.filter((f) => f?.geometry && f.properties?.id != null);
  if (!feats.length) throw new UserError(`layer "${layer}" has no features`);
  if (feats.length > 60) throw new UsageError(`${feats.length} features: doorstep is for the options people choose between (≤ 60). Use a smaller layer.`);
  const door = (f) => {
    const e = f.properties.entrance;
    return Array.isArray(e) && e.length === 2 && e.every(Number.isFinite) ? e : representativePoint(f.geometry);
  };
  const parts = feats.map((f) => { const [lng, lat] = door(f); return `way(around:80,${lat.toFixed(6)},${lng.toFixed(6)})["highway"];\n  way(around:600,${lat.toFixed(6)},${lng.toFixed(6)})["highway"~"^(primary|secondary|trunk)$"];`; });
  const q = `[out:json][timeout:60];\n(\n  ${parts.join('\n  ')}\n);\nout geom qt;`;
  out.log(`Querying OpenStreetMap for the streets at ${feats.length} door(s)…`);
  const data = await overpass(q, { timeoutS: 60 });
  const ways = (data.elements || []).filter((e) => e.type === 'way' && e.geometry && e.tags?.highway)
    .map((e) => ({ id: e.id, hw: e.tags.highway, name: e.tags.name || null, en: e.tags['name:en'] || null, coords: e.geometry.map((p) => [p.lon, p.lat]) }));
  const rows = [];
  for (const f of feats) {
    const d = door(f);
    const score = (list) => list.map((w) => ({ w, n: nearestOnLine(d, w.coords) })).filter((x) => x.n && x.n.dist_m <= maxDist).sort((a, b) => a.n.dist_m - b.n.dist_m);
    let near = score(ways.filter((w) => CAND.includes(w.hw)));
    let foot = false;
    if (!near.length) { near = score(ways.filter((w) => FOOT.includes(w.hw))); foot = near.length > 0; }
    const p = f.properties;
    // the street in the item's address wins over a nearer unnamed service lane (the door faces the address street)
    const addr = `${p.address || ''} ${p.address_zh || ''} ${p.address_en || ''}`.replace(/\s+/g, '').replace(/台/g, '臺');
    const onAddr = near.filter((x) => x.w.name && addr.includes(x.w.name.replace(/\s+/g, '').replace(/台/g, '臺')) || (x.w.en && addr.includes(x.w.en.replace(/\s+/g, ''))));
    if (onAddr.length) near = [...onAddr, ...near.filter((x) => !onAddr.includes(x))];
    for (const k of ['sv_viewpoint', 'sv_heading', 'street_name', 'street_name_local', 'street_class', 'main_road_m']) delete p[k];
    if (near.length) {
      const { w, n } = near[0];
      p.sv_viewpoint = n.point.map(round6);
      if (n.dist_m >= 3) p.sv_heading = bearing(n.point, d);
      // named neighbour when the nearest way is an unnamed service lane
      const named = w.name ? w : near.find((x) => x.w.name)?.w;
      if (named?.en || named?.name) p.street_name = named.en || named.name;
      if (named?.name && named.name !== p.street_name) p.street_name_local = named.name;
      p.street_class = foot ? 'lane' : classOf(w.hw);
    }
    let mainD = Infinity;
    for (const w of ways.filter((x) => MAIN.includes(x.hw))) { const n = nearestOnLine(d, w.coords); if (n && n.dist_m < mainD) mainD = n.dist_m; }
    if (Number.isFinite(mainD) && mainD <= 600) p.main_road_m = Math.round(mainD);
    rows.push({ id: p.id, street: p.street_name || null, local: p.street_name_local || null, class: p.street_class || null, viewpoint_m: near[0] ? Math.round(near[0].n.dist_m) : null,
      heading: p.sv_heading ?? null, main_road_m: p.main_road_m ?? null, footway_only: foot });
  }
  writeGeoJSON(layerPath(site, layer), fc);
  mergeMetrics(site.dir, {
    main_road_m: { label: 'Main road', short: 'Main road', unit: 'm', format: 'int', better: 'higher', basis: 'counted', confidence: 'medium',
      source: 'OpenStreetMap (primary/secondary/trunk roads) via Overpass', scale: 'straight line from the door', good: 150, bad: 15, threshold: 25, cmd: 'doorstep' },
    street_class: { label: 'Street at the door', basis: 'counted', confidence: 'medium', source: 'OpenStreetMap highway class', display: true, format: 'text', cmd: 'doorstep' },
  }, 'doorstep');
  const missing = rows.filter((r) => r.viewpoint_m == null).map((r) => r.id);
  out.result({ ok: true, layer, items: rows, wrote: [path.relative(site.dir, layerPath(site, layer)), 'data/metrics.json'] }, [
    `Doorstep facts for ${rows.length} ${layer} feature(s):`,
    ...rows.map((r) => `  ${String(r.id).padEnd(14)} ${r.class ? `${r.class} · ${r.street || '(unnamed)'}${r.local ? ` (${r.local})` : ''}` : 'no street within ' + maxDist + ' m'}` +
      ` · main road ${r.main_road_m != null ? r.main_road_m + ' m' : '> 600 m'}${r.heading != null ? ` · camera ${r.viewpoint_m} m away, heading ${r.heading}°` : r.viewpoint_m != null ? ' · door is on the street (no heading)' : ''}`),
    missing.length ? `  ${missing.length} without a street within ${maxDist} m (link-outs use the feature point): ${missing.join(', ')}` : null,
  ]);
  return 0;
}
