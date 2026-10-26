// tw-night-markets: Taipei's official vendor zones (臺北市攤販集中場, data.gov.tw 121594) with opening hours → points that
// "light up" on the time slider, English names from OpenStreetMap, optional real outlines (OSM) and OSM-only markets.
import { haversine, bboxAround, parseBBox, representativePoint, round6, pointInPolygonGeom, assembleRings, UsageError, UserError } from '../lib/util.mjs';
import { checkLayerId, layerBBox, viewBounds, configLayer, layerHint, registerLayer, loadLayer } from '../lib/site.mjs';
import { decodeTaiwanText, parseCSV } from '../lib/cmd-adapter.mjs';
import { bufferLine } from '../lib/geo.mjs';
import { hasLatin } from './lib/twnorm.mjs';

export const SOURCE = {
  id: 'data.taipei/121594', dataset: 121594, label: 'Taipei vendor zones (Markets Administration Office)',
  url: 'https://data.taipei/api/dataset/c013d9ec-a550-46bd-ac60-45f085930706/resource/4874f750-b972-4c42-ad76-986960670c70/download',
  page: 'https://data.gov.tw/dataset/121594',
};
export const ATTRIBUTION = '夜市資料：臺北市政府市場處 (data.gov.tw，政府資料開放授權條款第1版)';

export const meta = {
  name: 'tw-night-markets',
  describe: 'Taipei night markets and evening vendor zones with hours (data.gov.tw 121594) + OSM names/outlines → points that glow on the time slider',
  sources: [{ id: SOURCE.id, licence: 'OGDL-Taiwan-1.0', url: SOURCE.page }, { id: 'openstreetmap', licence: 'ODbL', url: 'https://www.openstreetmap.org/copyright' }],
  flags: { bbox: 'string', around: 'string', radius: 'number', layer: 'string', areas: 'bool', 'add-osm': 'bool', 'include-day': 'bool', names: 'string', force: 'bool' },
  help: `adapter tw-night-markets <site> [--bbox w,s,e,n | --around hotels --radius 2500] [--layer nightmarkets] [--areas] [--add-osm]
                            [--include-day] [--names '{"tpe-43":"Yanping N. Rd night stalls"}'] [--refresh] [--json]
  --around hotels --radius 2500 keeps markets within 2500 m of ANY feature of the layer (a circle per feature, not the
  bounding box of them all).
  Reads Taipei's official vendor-zone list (data.gov.tw 121594: name, district, days, start/end time, street extent,
  coordinates) and writes data/<layer>.geojson (points, kind "night_market", emoji 🏮) with time_from/time_to (past
  midnight → 24+, e.g. 18-24), hours_text, days, address, district and source. Only zones open in the evening
  (window covers 20:00) are kept unless --include-day (day markets get kind "market", emoji 🧺).
  name_en comes from an OpenStreetMap marketplace / night market within 150 m; others keep needs_english: true (give
  English names with --names, keyed by feature id). --add-osm adds OSM night markets the dataset lacks (e.g. Shilin),
  marked source "OpenStreetMap". --areas writes data/<layer>-areas.geojson with the real OSM outline (marketplace
  area, or a pedestrian street named 夜市 buffered by 8 m) for matched markets only; nothing is ever invented.
  Registers in map.config.json (if absent): { "id": "nightmarkets", "type": "points", "data": "data/nightmarkets.geojson", "style": { "emoji": "🏮", "glow": true } }.`,
};

// "121°29'29.7" → 121.491583 ; also plain decimals
export function dms(s) {
  const t = String(s || '').trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*[°度]\s*(\d+(?:\.\d+)?)?\s*['′分]?\s*(\d+(?:\.\d+)?)?/);
  if (!m) return null;
  return Number(m[1]) + Number(m[2] || 0) / 60 + Number(m[3] || 0) / 3600;
}
// Hours from start/end fields or free text. End ≤ start wraps past midnight (17:00-00:00 → 17-24).
export function parseHours(start, end, text = '') {
  const hm = (s) => { const m = String(s || '').match(/(\d{1,2})[:：時点]?(\d{2})?/); if (!m) return null; return Number(m[1]) + Number(m[2] || 0) / 60; };
  let a = hm(start), b = hm(end);
  if ((a == null || b == null) && text) {
    const m = String(text).match(/(?:營業時間)?[:：]?\s*(凌晨)?(\d{1,2})[:：]?(\d{2})?\s*[-~～至到]\s*(凌晨|翌日)?(\d{1,2})[:：]?(\d{2})?/);
    if (m) { a = Number(m[2]) + Number(m[3] || 0) / 60; b = Number(m[5]) + Number(m[6] || 0) / 60; if (m[4] && b < 12) b += 24; }
  }
  if (a == null || b == null) return null;
  if (b <= a) b += 24;
  return { from: Math.round(a * 4) / 4, to: Math.round(b * 4) / 4 };
}
const DAYS = { 每日: 'daily', 日: 'day session', 夜: 'night session', 週六: 'Saturdays', 週日: 'Sundays', 假日: 'weekends' };
const two = (h) => { const x = ((h % 24) + 24) % 24; return `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.round((x % 1) * 60)).padStart(2, '0')}`; };

export async function loadZones(ctx) {
  const cached = ctx.cached('zones.json');
  if (cached) { try { const d = (await import('node:fs')).readFileSync(cached, 'utf8'); const j = JSON.parse(d); if (j.rows?.length) return j; } catch {} }
  const metaDs = await ctx.dataGovTw(SOURCE.dataset);
  const url = metaDs?.distribution?.find((d) => /data\.taipei/.test(d.url || ''))?.url || SOURCE.url;
  ctx.log('  Downloading Taipei vendor zones (data.gov.tw 121594)…');
  const { buf } = await ctx.fetchBuffer(url, { label: 'data.taipei (121594)', timeoutMs: 60000 });
  const { text, encoding } = decodeTaiwanText(buf);
  const t = text.trim();
  const recs = t.startsWith('[') || t.startsWith('{') ? (() => { const j = JSON.parse(t); return Array.isArray(j) ? j : j.result?.results || []; })() : parseCSV(text);
  const rows = recs.map((r) => ({ seq: r.seqno || r._id || '', district: r.stitle || '', body: r.xbody || '', days: r.xcreatedDate || '', start: r.xstartTime || '',
    end: r.xendTime || '', extent: r.xAddress || '', lng: dms(r.GTag_longitude ?? r.longitude), lat: dms(r.GTag_latitude ?? r.latitude) }))
    .filter((r) => r.body && Number.isFinite(r.lng) && Number.isFinite(r.lat));
  if (!rows.length) throw new UserError('data.taipei 121594 parsed to 0 rows (format changed?)');
  const out = { as_of: metaDs?.updated || null, fetched_at: new Date().toISOString(), url, encoding, rows };
  const fs = await import('node:fs');
  fs.writeFileSync(ctx.cachePath('zones.json'), JSON.stringify(out));
  ctx.writeMeta('zones', { fetched_at: out.fetched_at, source_updated: out.as_of, url, rows: rows.length, encoding });
  return out;
}

function cleanName(body) {
  const paren = [...body.matchAll(/[（(〈]([^)）〉]+)[)）〉]/g)].map((m) => m[1]);
  let base = body.replace(/[（(〈][^)）〉]*[)）〉]/g, '').trim();
  const nm = paren.find((p) => p.includes(base + '夜市'));
  if (nm) return base + '夜市';
  if (/^(.+?)(觀光)?夜市/.test(base)) return base;
  return base;
}

export async function run(ctx, args) {
  const layer = checkLayerId(args.layer || 'nightmarkets');
  const site = ctx.site;
  let bbox = null, aroundPts = null;
  if (args.bbox) bbox = parseBBox(args.bbox);
  else if (args.around) {
    bbox = layerBBox(site, args.around, args.radius ?? 2500);
    aroundPts = (loadLayer(site, args.around).features || []).filter((f) => f?.geometry).map((f) => representativePoint(f.geometry)).filter(Boolean);
  }
  else bbox = viewBounds(site);
  // --around: a real circle around each feature (the bbox of all of them reached 3 km past the nearest hotel)
  const aroundR = args.radius ?? 2500;
  const nearAround = (lng, lat) => !aroundPts || aroundPts.some((c) => haversine(c, [lng, lat]) <= aroundR);
  if (!bbox) throw new UsageError('give --bbox w,s,e,n or --around <layer> [--radius 2500] (map.config.json has no view.bounds)');
  let names = {};
  if (args.names) { try { names = JSON.parse(args.names); } catch (e) { throw new UsageError(`--names is not valid JSON: ${e.message}`); } }
  const zones = await loadZones(ctx);
  const inBox = (lng, lat) => lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3] && nearAround(lng, lat);
  // merge duplicate rows (same place, several sessions/days) into one feature with combined hours
  const groups = new Map();
  for (const r of zones.rows) {
    if (!inBox(r.lng, r.lat)) continue;
    const h = parseHours(r.start, r.end, r.body + ' ' + r.extent);
    const key = cleanName(r.body) + '|' + r.lng.toFixed(4) + ',' + r.lat.toFixed(4);
    const g = groups.get(key) || { rows: [], hours: [] };
    g.rows.push(r); if (h) g.hours.push({ ...h, days: r.days });
    groups.set(key, g);
  }
  const feats = [];
  for (const g of groups.values()) {
    const r = g.rows[0];
    const evening = g.hours.filter((h) => h.from <= 20 && h.to >= 20.5 || h.from >= 15);
    const isNight = g.hours.some((h) => h.from >= 15 && h.to >= 21) || /夜市/.test(r.body);
    if (!evening.length && !args['include-day'] && !/夜市/.test(r.body)) continue;
    const use = (evening.length ? evening : g.hours).sort((a, b) => b.from - a.from)[0] || null;
    const id = `tpe-${String(r.seq).replace(/\D/g, '') || feats.length + 1}`;
    const name = cleanName(r.body);
    const hoursText = g.hours.map((h) => `${two(h.from)}–${two(h.to)}${h.days && h.days !== '每日' ? ` (${DAYS[h.days] || h.days})` : ''}`).join(', ');
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [round6(r.lng), round6(r.lat)] }, properties: {
      id, name, kind: isNight ? 'night_market' : 'market', emoji: isNight ? '🏮' : '🧺',
      // the dataset lists the hours vendors may trade (攤販集中場), not opening hours: the card says so
      ...(use ? { time_from: use.from, time_to: use.to, hours_known: true, hours_label: 'Permitted vendor hours', hours_basis: 'registry' } : { hours_known: false }),
      hours_text: hoursText.slice(0, 60) || null, days: [...new Set(g.rows.map((x) => DAYS[x.days] || x.days).filter(Boolean))].join(', ') || null,
      address: r.extent ? r.extent.slice(0, 80) : null, district: r.district ? r.district + '區' : null,
      source: 'Taipei Markets Office (data.gov.tw 121594)', source_id: SOURCE.id, as_of: zones.as_of,
    } });
  }
  // OSM: names, outlines and markets the dataset lacks
  const osmB = [bbox[1] - 0.003, bbox[0] - 0.003, bbox[3] + 0.003, bbox[2] + 0.003].map((x) => x.toFixed(6)).join(',');
  let osm = [], osmError = null;
  try {
    const q = `[out:json][timeout:60];
(
  nwr["amenity"="marketplace"](${osmB});
  nwr["name"~"夜市|[Nn]ight [Mm]arket"](${osmB});
  way["highway"="pedestrian"]["name"~"夜市"](${osmB});
);
out geom qt;`;
    ctx.log('  Querying OpenStreetMap for marketplaces and night markets (names, outlines)…');
    // optional (names, outlines): at most 35 s of the command's limit when Overpass is busy
    const data = ctx.withCap ? await ctx.withCap(35000, () => ctx.overpass(q, { timeoutS: 30 })) : await ctx.overpass(q, { timeoutS: 60 });
    osm = (data.elements || []).filter((e) => e.tags?.name).map((e) => {
      let geom = null, c = null;
      if (e.type === 'node') c = [e.lon, e.lat];
      else if (e.type === 'way' && e.geometry) {
        const coords = e.geometry.map((p) => [p.lon, p.lat]);
        const closed = coords.length > 3 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
        if (closed && e.tags.highway !== 'pedestrian') geom = { type: 'Polygon', coordinates: [coords.map((p) => p.map(round6))] };
        else geom = { type: 'LineString', coordinates: coords };
        c = coords[Math.floor(coords.length / 2)];
      } else if (e.type === 'relation' && e.members) {
        const rings = assembleRings(e.members.filter((m) => m.geometry && m.role !== 'inner').map((m) => m.geometry.map((p) => [p.lon, p.lat])));
        if (rings.length) { geom = { type: 'Polygon', coordinates: [rings[0].map((p) => p.map(round6))] }; c = rings[0][0]; }
      }
      if (!c && e.center) c = [e.center.lon, e.center.lat];
      if (geom && geom.type === 'Polygon' && !c) c = geom.coordinates[0][0];
      return c ? { osm: `${e.type}/${e.id}`, name: e.tags.name, name_en: e.tags['name:en'] || null, tags: e.tags, c, geom } : null;
    }).filter(Boolean);
  } catch (e) { osmError = e.message; ctx.log(`  (OpenStreetMap lookup skipped: ${e.message})`); }
  const isNM = (o) => /夜市|night market/i.test(o.name + ' ' + (o.name_en || ''));
  // a real market, not a stall or an entrance named after one
  const isMarket = (o) => (o.tags.amenity === 'marketplace' || o.tags.highway === 'pedestrian' || o.tags.place || o.tags.tourism === 'attraction' || (!o.tags.shop && !o.tags.amenity && !o.tags.craft))
    && /夜市$|夜市[)）]?$|night market\b/i.test(o.name.replace(/\s+/g, '') + ' ' + (o.name_en || '')) && !/入口|entrance|羹|麵|飯|湯|店$/i.test(o.name);
  const related = (f, o) => { const b = f.properties.name.replace(/夜市$/, ''); const n = o.name.replace(/夜市$/, ''); return b.length >= 2 && (n.includes(b) || b.includes(n)); };
  // OSM element for a dataset point: inside its outline, or a related name within 150 m, or anything within 40 m
  const near = (f, maxM) => {
    const c = f.geometry.coordinates;
    let best = null, bd = Infinity;
    for (const o of osm) {
      const inside = o.geom?.type === 'Polygon' && pointInPolygonGeom(c, o.geom);
      const d = inside ? 0 : haversine(c, o.c);
      if (d > maxM) continue;
      const rel = related(f, o);
      if (!inside && !rel && d > 40) continue;
      const score = d + (isNM(o) ? 0 : 40) - (rel ? 100 : 0);
      if (score < bd) { bd = score; best = { o, d, rel }; }
    }
    return best;
  };
  const used = new Set();
  const areaFeats = [];
  for (const f of feats) {
    const m = near(f, 150);
    if (m) {
      used.add(m.o.osm);
      // an English name only from the same market (inside its outline or a related name), and never one another
      // market already has: 梧州街 must not borrow "Guangzhou Street Night Market" from its neighbour
      const same = m.d === 0 || m.rel;
      if (!f.properties.name_en && m.o.name_en && same && !feats.some((x) => x !== f && x.properties.name_en === m.o.name_en)) f.properties.name_en = m.o.name_en;
      f.properties.osm_id = m.o.osm;
      if (isNM(m.o) && f.properties.kind !== 'night_market') { f.properties.kind = 'night_market'; f.properties.emoji = '🏮'; }
      if (args.areas && m.o.geom && isNM(m.o)) {
        const g = m.o.geom.type === 'Polygon' ? m.o.geom : { type: 'Polygon', coordinates: [bufferLine(m.o.geom.coordinates, 8)] };
        areaFeats.push({ type: 'Feature', geometry: g, properties: { id: f.properties.id, name: f.properties.name, name_en: f.properties.name_en || null, for: f.properties.id,
          geometry: 'osm', osm_id: m.o.osm, time_from: f.properties.time_from, time_to: f.properties.time_to, source: 'OpenStreetMap' } });
      }
    }
    // street-named zones (延平北路3段) vs the market's common short name (延三觀光夜市): same first character within 400 m
    if (!m && f.properties.kind === 'night_market') {
      const alias = osm.filter((o) => isMarket(o) && !used.has(o.osm) && o.name[0] === f.properties.name[0] && haversine(f.geometry.coordinates, o.c) <= 400)
        .sort((a, b) => haversine(f.geometry.coordinates, a.c) - haversine(f.geometry.coordinates, b.c))[0];
      if (alias) { used.add(alias.osm); f.properties.osm_id = alias.osm; f.properties.aka = alias.name; if (!f.properties.name_en && alias.name_en) f.properties.name_en = alias.name_en; }
    }
    if (names[f.properties.id]) f.properties.name_en = String(names[f.properties.id]).slice(0, 80);
    if (!f.properties.name_en || !hasLatin(f.properties.name_en)) f.properties.needs_english = true;
  }
  let added = 0;
  if (args['add-osm']) {
    for (const o of osm) {
      if (!isMarket(o) || used.has(o.osm) || !inBox(o.c[0], o.c[1])) continue;
      if (feats.some((f) => haversine(f.geometry.coordinates, o.c) < 150)) continue;
      // one feature per market (OSM may hold the market as several streets/areas, or under the same English name)
      if (feats.some((f) => (f.properties.name === o.name || (o.name_en && f.properties.name_en === o.name_en) || related(f, o)) && haversine(f.geometry.coordinates, o.c) < 800)) continue;
      const id = 'osm-' + o.osm.replace('/', '-');
      const c = o.geom?.type === 'Polygon' ? representativePoint(o.geom) : o.c;
      const oh = o.tags.opening_hours ? parseHours(...(o.tags.opening_hours.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/) || []).slice(1, 3)) : null;
      const f = { type: 'Feature', geometry: { type: 'Point', coordinates: c.map(round6) }, properties: {
        id, name: o.name, ...(o.name_en ? { name_en: o.name_en } : { needs_english: true }), kind: 'night_market', emoji: '🏮',
        ...(oh ? { time_from: oh.from, time_to: oh.to, hours_known: true, hours_text: o.tags.opening_hours.slice(0, 60) } : { hours_known: false }),
        address: o.tags['addr:street'] || null, district: null, source: 'OpenStreetMap', osm_id: o.osm } };
      if (names[id]) { f.properties.name_en = String(names[id]).slice(0, 80); delete f.properties.needs_english; }
      feats.push(f); added++; used.add(o.osm);
      if (args.areas && o.geom) areaFeats.push({ type: 'Feature', geometry: o.geom.type === 'Polygon' ? o.geom : { type: 'Polygon', coordinates: [bufferLine(o.geom.coordinates, 8)] },
        properties: { id, name: o.name, name_en: o.name_en || null, for: id, geometry: 'osm', osm_id: o.osm, source: 'OpenStreetMap' } });
    }
  }
  if (!feats.length) throw new UserError(`no vendor zones or night markets inside ${bbox.join(',')}${osmError ? ' (and OpenStreetMap was unreachable, so --add-osm found nothing: retry in a few minutes)' : ''}; widen --radius or use --include-day`);
  const fc = { type: 'FeatureCollection', attribution: `${ATTRIBUTION} · © OpenStreetMap contributors`, source: { id: SOURCE.id, url: SOURCE.page, as_of: zones.as_of }, features: feats };
  const w = ctx.writeOwnedLayer(layer, fc, { args: { bbox: bbox.join(','), areas: !!args.areas, add_osm: !!args['add-osm'] }, force: args.force });
  const wrote = [w.rel];
  if (args.areas) {
    const aw = ctx.writeOwnedLayer(`${layer}-areas`, { type: 'FeatureCollection', attribution: '© OpenStreetMap contributors', features: areaFeats }, { args: { for: layer }, force: args.force });
    wrote.push(aw.rel);
  }
  if (ctx.addAttribution(ATTRIBUTION)) wrote.push('map.config.json');
  const hint = layerHint(site, layer, 'points', { title: 'Night markets', style: { emoji: '🏮', color: '#f59e0b', size: 'm', glow: true }, label: 'name', group: 'Around' });
  const lines = [`tw-night-markets: ${feats.length} market(s) in the area (${feats.length - added} from data.gov.tw 121594 as of ${zones.as_of}, ${added} from OpenStreetMap)` +
    `${args.areas ? `, ${areaFeats.length} real outline(s)` : ''}:`];
  for (const f of feats.slice(0, 20)) {
    const p = f.properties;
    lines.push(`  ${p.emoji} ${p.id.padEnd(16)} ${p.name}${p.name_en ? ` / ${p.name_en}` : ' (needs English)'} · ${p.hours_known ? `${two(p.time_from)}–${two(p.time_to)}` : 'hours unknown'}${p.source === 'OpenStreetMap' ? ' · OSM' : ''}`);
  }
  if (feats.length > 20) lines.push(`  … ${feats.length - 20} more`);
  if (osmError) lines.push('  OpenStreetMap was unreachable: no English names, outlines or OSM-only markets this run. Re-run in a few minutes (cached datasets make it fast).');
  const noEn = feats.filter((f) => f.properties.needs_english).map((f) => f.properties.id);
  if (noEn.length) lines.push(`  ${noEn.length} without an English name: give them with --names '{"${noEn[0]}":"…"}' (romanise; do not invent).`);
  const registered = registerLayer(site, hint);
  if (registered) { lines.push(registered); if (!wrote.includes('map.config.json')) wrote.push('map.config.json'); }
  return { summary: lines[0], lines, count: feats.length, osm_added: added, osm_error: osmError, outlines: areaFeats.length, needs_english: noEn, wrote, registered_layer: registered ? hint : null };
}
