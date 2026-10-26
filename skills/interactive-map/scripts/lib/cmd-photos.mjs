// `photos`: dated doorstep street photos from Panoramax (open, CC BY-SA 4.0, no key) → data/photos.json.
// ENGINE-SPEC-v0.2 §7.2. Every photo carries its author, licence, date and viewer link; "none within 40 m" is said
// plainly, and a farther photo is never shown in its place.
import path from 'node:path';
import { parseArgs, makeOut, writeJSON, readJSON, exists, representativePoint, haversine, bboxAround, round6, parseList, UsageError, UserError } from './util.mjs';
import { fetchJSON, spaced, overpass, isSkip } from './net.mjs';
import { openSite, checkLayerId, loadLayer } from './site.mjs';
import { bearing, normAngle, isNight, nearestOnLine } from './geo.mjs';
import { mergeMetrics } from './metrics.mjs';

export const PANORAMAX_API = (process.env.UW_PANORAMAX || 'https://api.panoramax.xyz').replace(/\/+$/, '');
export const ATTRIBUTION = 'Street photos: Panoramax contributors (CC BY-SA 4.0)';

export const help = `photos <dir> --layer hotels [--radius 40] [--instances osm-tw,ign] [--max-age-years 6] [--prefer 360|flat] [--keep-elevated] [--json]
  Finds a street-level photo of each feature's door (its "entrance" [lng,lat], else its point) on Panoramax
  (api.panoramax.xyz federates the OSM Taiwan server panoramax.osm.tw and others):
    1. pictures that LOOK AT the door: /api/search?place_position=<lng,lat>&place_distance=0-<radius>
    2. else any picture within --radius m (360° ones always face the door; flat ones are marked facing: false)
    3. drop pictures taken from a bridge, flyover, motorway or trunk road (the camera sits on a different street from
       the door: "Look at the door" would show a noise barrier); --keep-elevated keeps them
    4. pick facing, then on the door's own street (doorstep street_name / within 15 m of sv_viewpoint), then 360°
       (unless --prefer flat), then newest, then nearest; keep 2 alternates
    5. nothing usable within --radius: record why and the distance to the nearest photo ≤ 150 m (never shown)
  --instances keeps only pictures from those Panoramax instances (instance_name, e.g. osm-tw); default any.
  --max-age-years drops older pictures (default 6).
  Writes data/photos.json: per "<layer>:<id>": status found|none, the photo (thumb_url 500 px, sd_url 2048 px for the
  360° viewer, viewer_url, is_360, captured_at, author, licence, distance_m, heading, bearing_to_item, yaw_to_item,
  facing, night) + alternates. Max 2 requests/s; responses cached in .uwcache/.
  Adds to map.config.json: "photos": { "data": "data/photos.json", "layers": ["hotels"] }   (viewer: built-in 360° by default; "link" opens Panoramax)`;

function hostOf(u) { try { return new URL(u).origin; } catch { return null; } }

// Panoramax search feature → photos.json photo (or null when unusable)
export function toPhoto(f, target) {
  const p = f.properties || {};
  const via = (f.links || []).find((l) => l.rel === 'via');
  const lic = (f.links || []).find((l) => l.rel === 'license');
  const [lng, lat] = f.geometry?.coordinates || [];
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const thumb = f.assets?.thumb?.href || p['geovisio:thumbnail'];
  const sd = f.assets?.sd?.href || null;
  if (!thumb) return null;
  const instHost = hostOf(via?.href) || hostOf(thumb);
  const is360 = Number(p['pers:interior_orientation']?.field_of_view) === 360;
  const heading = Number.isFinite(Number(p['view:azimuth'])) ? Number(p['view:azimuth']) : null;
  const dist = haversine([lng, lat], target);
  const b = bearing([lng, lat], target);
  const captured = p.datetimetz || p.datetime || null;
  const author = (f.providers || []).find((x) => (x.roles || []).includes('producer'))?.name || p['geovisio:producer'] || null;
  const licRaw = String(p.license || '').toUpperCase();
  const licence = /CC-BY-SA-4\.0/.test(licRaw) ? 'CC BY-SA 4.0' : /CC-BY-4\.0/.test(licRaw) ? 'CC BY 4.0' : /CC0/.test(licRaw) ? 'CC0' : licRaw.replace(/-/g, ' ') || null;
  const yaw = heading == null ? null : Math.round(normAngle(b - heading));
  // a flat photo faces the door when the door lies inside its field of view (default ±40° when unknown)
  const fov = Number(p['pers:interior_orientation']?.field_of_view) || 80;
  const facing = is360 || (yaw != null && Math.abs(yaw) <= Math.min(80, fov / 2 + 10));
  const t = Date.parse(captured || '');
  return {
    id: f.id, instance: via?.instance_name || null, thumb_url: thumb, sd_url: sd, viewer_url: instHost ? `${instHost}/#focus=pic&pic=${f.id}` : null,
    is_360: is360, captured_at: captured, author, licence, licence_url: lic?.href || null,
    distance_m: Math.round(dist), heading, bearing_to_item: b, yaw_to_item: yaw, facing, night: Number.isFinite(t) ? isNight(t, lat, lng) : null,
    lng: round6(lng), lat: round6(lat),
  };
}

export async function run(argv) {
  const args = parseArgs(argv, { layer: 'string', radius: 'number', instances: 'string', 'max-age-years': 'number', prefer: 'string', 'keep-elevated': 'bool' }, { positionals: [1, 1], command: 'photos' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const layer = checkLayerId(args.layer);
  const radius = args.radius ?? 40;
  if (radius < 5 || radius > 150) throw new UsageError('--radius must be 5-150 m (a doorstep photo, not a neighbourhood one)');
  const prefer = args.prefer || '360';
  if (!['360', 'flat'].includes(prefer)) throw new UsageError('--prefer must be 360 or flat');
  const instances = parseList(args.instances);
  const maxAge = args['max-age-years'] ?? 6;
  const fc = loadLayer(site, layer);
  const feats = fc.features.filter((f) => f?.geometry && f.properties?.id != null);
  if (!feats.length) throw new UserError(`layer "${layer}" has no features`);
  if (feats.length > 40) throw new UsageError(`${feats.length} features: photos are for the options people choose between (≤ 40)`);
  const file = path.join(site.dir, 'data', 'photos.json');
  let prev = null;
  try { if (exists(file)) prev = readJSON(file); } catch {}
  const items = { ...(prev?.items || {}) };
  for (const k of Object.keys(items)) if (k.startsWith(layer + ':')) delete items[k];
  const now = new Date().toISOString();
  const minTime = Date.now() - maxAge * 365.25 * 864e5;
  const search = async (qs) => {
    await spaced('panoramax', 500);
    const j = await fetchJSON(`${PANORAMAX_API}/api/search?${qs}`, { label: 'Panoramax (api.panoramax.xyz)', cacheMaxAgeMs: 3 * 864e5, timeoutMs: 30000 });
    return Array.isArray(j.features) ? j.features : [];
  };
  const keep = (ph) => ph && (!instances.length || instances.includes(ph.instance)) && (!ph.captured_at || Date.parse(ph.captured_at) >= minTime);
  const rows = [];
  let skipped = null;
  for (const [fi, f] of feats.entries()) {
   try {
    const p = f.properties;
    const e = p.entrance;
    const target = Array.isArray(e) && e.length === 2 && e.every(Number.isFinite) ? e : representativePoint(f.geometry);
    const ref = `${layer}:${p.id}`;
    const facingRaw = await search(`place_position=${target[0].toFixed(6)},${target[1].toFixed(6)}&place_distance=0-${radius}&limit=20`);
    let list = facingRaw.map((x) => toPhoto(x, target)).filter(keep).filter((ph) => ph.distance_m <= radius);
    for (const ph of list) ph.facing = true; // the API selected them as looking at the place
    let usedFallback = false;
    if (!list.length) {
      const b = bboxAround(target, radius);
      const raw = await search(`bbox=${b.map((x) => x.toFixed(6)).join(',')}&limit=40`);
      list = raw.map((x) => toPhoto(x, target)).filter(keep).filter((ph) => ph.distance_m <= radius);
      usedFallback = true;
    }
    // where each camera stood: on the door's street, or up on a bridge / expressway above it
    let rejected = 0;
    if (list.length) {
      const roads = await roadsAround(target, radius + 40).catch((e) => { out.warn(`${ref}: street check skipped (${e.message})`); return null; });
      if (roads) {
        // GPS puts a camera on a ramp next to the street below it, so the camera's heading decides: it drove ALONG
        // the road it was on. On the door's street = that street within 12 m and running the way the camera faced;
        // elevated = a bridge / expressway within 20 m running that way, while the door's street does not.
        const along = (ph, near) => {
          if (ph.heading == null) return true;
          const c = near.r.coords, i = Math.min(near.n.index, c.length - 2);
          const rb = bearing(c[i], c[i + 1]);
          const d = Math.abs(normAngle(ph.heading - rb));
          return Math.min(d, 180 - d) <= 25;
        };
        const isDoorStreet = (r) => (p.street_name_local && r.name === p.street_name_local) || (p.street_name && r.en === p.street_name);
        for (const ph of list) {
          const near = roads.map((r) => ({ r, n: nearestOnLine([ph.lng, ph.lat], r.coords) })).filter((x) => x.n).map((x) => ({ ...x, d: x.n.dist_m })).sort((a, b) => a.d - b.d);
          ph.street = near[0] && near[0].d <= 12 ? near[0].r.name || near[0].r.cls : null;
          ph.on_street = near.some((x) => x.d <= 12 && isDoorStreet(x.r) && along(ph, x));
          ph.elevated = !ph.on_street && near.some((x) => x.d <= 20 && x.r.elevated && along(ph, x));
        }
        if (!args['keep-elevated']) { const before = list.length; list = list.filter((ph) => !ph.elevated); rejected = before - list.length; }
      }
      const vp = Array.isArray(p.sv_viewpoint) ? p.sv_viewpoint : null;
      for (const ph of list) if (vp && haversine([ph.lng, ph.lat], vp) <= 15) ph.on_street = true;
    }
    // newest by capture DAY, so the nearest frame of the same drive-by wins over one taken 2 s later 30 m away
    const rank = (ph) => [ph.facing ? 0 : 1, ph.on_street === false ? 1 : 0, (prefer === '360' ? !ph.is_360 : ph.is_360) ? 1 : 0, -Math.floor((Date.parse(ph.captured_at || '') || 0) / 864e5), ph.distance_m];
    list.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0; });
    if (list.length) {
      // alternates: different capture sessions where possible (not 3 frames of the same drive-by)
      const best = list[0];
      const alts = [];
      for (const ph of list.slice(1)) {
        if (alts.length >= 2) break;
        if ([best, ...alts].some((x) => Math.abs((Date.parse(x.captured_at) || 0) - (Date.parse(ph.captured_at) || 0)) < 600e3)) continue;
        alts.push(ph);
      }
      for (const ph of list.slice(1)) { if (alts.length >= 2) break; if (!alts.includes(ph)) alts.push(ph); }
      items[ref] = { status: 'found', target: target.map(round6), photo: best, alternates: alts, searched: { radius_m: radius, at: now, method: usedFallback ? 'bbox' : 'place_position' } };
      rows.push({ ref, status: 'found', date: best.captured_at?.slice(0, 10), distance_m: best.distance_m, is_360: best.is_360, facing: best.facing, author: best.author, alternates: alts.length });
    } else {
      // honesty text only: how far is the nearest picture (≤ 150 m)?
      const b = bboxAround(target, 150);
      const raw = await search(`bbox=${b.map((x) => x.toFixed(6)).join(',')}&limit=100`);
      const ds = raw.map((x) => toPhoto(x, target)).filter(keep).map((ph) => ph.distance_m).filter((d) => d <= 150).sort((a, b2) => a - b2);
      items[ref] = { status: 'none', target: target.map(round6), ...(ds.length ? { nearest_m: ds[0] } : {}), ...(rejected ? { rejected_reason: `the ${rejected} within ${radius} m are from an elevated road` } : {}),
        searched: { radius_m: radius, instances: instances.length ? instances : ['any'], at: now } };
      rows.push({ ref, status: 'none', nearest_m: ds[0] ?? null, rejected });
    }
   } catch (e) {
    if (!isSkip(e)) throw e;
    // out of time: keep the photos found so far; features not reached keep what an earlier run found
    skipped = e;
    for (const g of feats.slice(fi)) { const r = `${layer}:${g.properties.id}`; if (prev?.items?.[r]) items[r] = prev.items[r]; }
    skipped.kept = `photos for ${rows.length} of ${feats.length} ${layer} (not reached: ${feats.slice(fi).map((g) => g.properties.id).join(', ')})`;
    break;
   }
  }
  if (skipped && !rows.length) throw skipped;
  const doc = { uw: { cmd: 'photos', generated_at: now, args: { layer, radius, ...(instances.length ? { instances } : {}), max_age_years: maxAge } },
    attribution: ATTRIBUTION, radius_m: radius, items };
  writeJSON(file, doc, { pretty: true });
  mergeMetrics(site.dir, { photo: { label: 'Doorstep photo', basis: 'measured', confidence: 'high', source: 'Panoramax (CC BY-SA 4.0)', scale: `within ${radius} m of the door`, display: true, format: 'text' } }, 'photos');
  const missing = rows.filter((r) => r.status === 'none');
  // map.config.json "photos": add it (or this layer to it) so the cards show the photos without a hand edit
  let cfgNote = null;
  const cfg = readJSON(site.cfgPath);
  const ph = cfg.photos && typeof cfg.photos === 'object' ? cfg.photos : null;
  if (!ph) { cfg.photos = { data: 'data/photos.json', layers: [layer] }; cfgNote = `map.config.json: added "photos": { "data": "data/photos.json", "layers": ["${layer}"] }.`; }
  else if (Array.isArray(ph.layers) && !ph.layers.includes(layer)) { ph.layers.push(layer); cfgNote = `map.config.json: added "${layer}" to photos.layers.`; }
  if (cfgNote) { writeJSON(site.cfgPath, cfg, { pretty: true }); site.config = cfg; }
  if (skipped) { if (cfgNote) out.log(cfgNote); throw skipped; }
  out.result({ ok: true, layer, items: rows, wrote: ['data/photos.json', 'data/metrics.json', ...(cfgNote ? ['map.config.json'] : [])] }, [
    `Doorstep photos for ${rows.length} ${layer} feature(s) (Panoramax, ≤ ${radius} m):`,
    ...rows.map((r) => r.status === 'found'
      ? `  ✓ ${r.ref.padEnd(18)} ${r.date} · ${r.distance_m} m · ${r.is_360 ? '360°' : 'flat'}${r.facing ? '' : ' · facing away'} · © ${r.author}${r.alternates ? ` (+${r.alternates} alt)` : ''}`
      : `  – ${r.ref.padEnd(18)} No street photo within ${radius} m${r.rejected ? ` (${r.rejected} taken from a bridge / expressway left out)` : r.nearest_m != null ? ` (nearest is ${r.nearest_m} m away)` : ' (none within 150 m)'}`),
    missing.length ? 'Cards say "No street photo within ' + radius + ' m" for these; never substitute a farther photo.' : null,
    cfgNote || 'map.config.json "photos" already lists this layer (credits are in the file; the engine shows them).',
  ]);
  return 0;
}

/** Named roads around a point with whether they are elevated (bridge, flyover, motorway, trunk or their links). */
async function roadsAround(c, m) {
  const q = `[out:json][timeout:25];way["highway"](around:${Math.round(m)},${c[1].toFixed(6)},${c[0].toFixed(6)});out geom tags qt;`;
  const data = await overpass(q, { timeoutS: 25 });
  return (data.elements || []).filter((e) => e.type === 'way' && e.geometry?.length > 1).map((e) => {
    const t = e.tags || {};
    const elevated = (t.bridge && t.bridge !== 'no') || Number(t.layer) >= 1 || /^(motorway|trunk)(_link)?$/.test(t.highway) || /viaduct|高架|快速/.test(String(t.name || ''));
    return { coords: e.geometry.map((p) => [p.lon, p.lat]), cls: t.highway, name: t.name || null, en: t['name:en'] || null, elevated };
  });
}
