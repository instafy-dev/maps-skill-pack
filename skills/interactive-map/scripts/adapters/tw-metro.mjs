// tw-metro: every Taipei Metro station from the operator's own open data (no key), with its entrances, so "how far is
// the MRT" never depends on a busy Overpass or Photon's partial answer. `uw places --kinds mrt_station` uses it first in
// the Taipei area; `uw adapter tw-metro` runs it on its own.
//   stations  data.gov.tw 131734 (臺北捷運車站資料服務: StationID, zh/en name, position, address)
//   entrances data.gov.tw 128428 (臺北捷運車站出入口座標: exit name/number, lng/lat, step-free) — Big5 CSV
//   lines     data.gov.tw 131733 (臺北捷運路線資料服務: LineID, zh/en name, colour)
// Stations that only appear in the entrance list (Circular line, Y) become a point at the mean of their entrances,
// with no English name (never invented). Not covered: Taoyuan Airport MRT, Danhai / Ankeng light rail, Kaohsiung,
// Taichung: outside the Taipei Metro area places falls back to OpenStreetMap.
import fs from 'node:fs';
import { haversine, bboxAround, parseBBox, parseLngLat, round6, UsageError, UserError } from '../lib/util.mjs';
import { checkLayerId, layerBBox, loadLayer, layerHint, registerLayer, viewBounds } from '../lib/site.mjs';
import { decodeTaiwanText, parseCSV } from '../lib/cmd-adapter.mjs';

export const SOURCES = {
  stations: { dataset: 131734, label: 'Taipei Metro stations', url: 'https://data.taipei/api/dataset/1eefa68d-7c8d-491b-8e75-66a161947426/resource/c77e91bf-067c-475e-917b-545ff62b7d76/download' },
  exits: { dataset: 128428, label: 'Taipei Metro station entrances', url: 'https://data.taipei/api/dataset/cfa4778c-62c1-497b-b704-756231de348b/resource/307a7f61-e302-4108-a817-877ccbfca7c1/download' },
  lines: { dataset: 131733, label: 'Taipei Metro lines', url: 'https://data.taipei/api/dataset/cb9b4bd5-a648-41be-9287-11bc5b3e2343/resource/8a0982a1-0caf-4997-8fc5-e143181bb4af/download' },
};
export const SOURCE_ID = 'data.gov.tw/131734+128428';
export const SOURCE_LABEL = 'Taipei Metro open data (data.gov.tw 131734, 128428)';
export const ATTRIBUTION = '捷運車站資料：臺北大眾捷運股份有限公司 (data.gov.tw，政府資料開放授權條款第1版)';
export const SCOPE = 'Taipei Metro (TRTC) incl. the Circular line; not the Taoyuan Airport MRT or light rail';
/** a query point further than this from every Taipei Metro station is outside the area this dataset answers for */
export const COVER_M = 3000;
const CACHE_FILE = 'network.json';
const CACHE_MAX_H = 24 * 14; // stations change rarely; a stale copy is still used when data.taipei is down

export const meta = {
  name: 'tw-metro',
  describe: 'Every Taipei Metro station with its entrances, zh/en names and lines (data.gov.tw 131734 + 128428, no key)',
  sources: [{ id: 'data.gov.tw/131734', licence: 'OGDL-Taiwan-1.0', url: 'https://data.gov.tw/dataset/131734' },
    { id: 'data.gov.tw/128428', licence: 'OGDL-Taiwan-1.0', url: 'https://data.gov.tw/dataset/128428' }],
  flags: { layer: 'string', around: 'string', radius: 'number', near: 'string', bbox: 'string', force: 'bool' },
  help: `adapter tw-metro <site> [--layer mrt] (--around hotels [--radius 800] | --near lng,lat [--radius 800] | --bbox w,s,e,n) [--refresh] [--json]
  Writes data/<layer>.geojson: one point per Taipei Metro station (kind "mrt_station", 🚇) with name (zh), name_en,
  station_code (R12…), lines, line_names, address and "entrances" ([{ ref, c: [lng,lat], step_free }]). enrich measures
  to the nearest entrance (--nearest, --route-to). Complete for ${SCOPE}.
  \`uw places … --kinds mrt_station\` uses this automatically in the Taipei area (--source osm to skip it).
  Data cached in $UW_CACHE/tw-metro/ (${CACHE_MAX_H / 24} days; --refresh to re-download). Credit: ${ATTRIBUTION}`,
};

// spelling slips in the published English names (the operator's own signage spells them this way)
const EN_FIX = { 'Minzuan W. Rd.': 'Minquan W. Rd.', 'Songliang Nanjing': 'Songjiang Nanjing', 'Xhongxiao Dunhua': 'Zhongxiao Dunhua', 'St.lgnatius High School': 'St. Ignatius High School' };
const unq = (s) => String(s ?? '').trim().replace(/^'+|'+$/g, '').trim();
/** "'{雙連,Shuanglian}'" → ['雙連', 'Shuanglian'];  "'{'淡水信義線','Tamsui-Xinyi Line'}'" → ['淡水信義線', 'Tamsui-Xinyi Line'] */
export function braces(s) {
  const m = unq(s).match(/^\{(.*)\}$/s);
  if (!m) return [];
  return m[1].split(',').map((x) => unq(x));
}
/** station name without "站" / exit suffixes, for joining exits to stations: "台北車站M5" → "台北車", "雙連站出口1" → "雙連" */
export const stationKey = (s) => String(s || '').trim().replace(/(出口[0-9A-Za-z]*|M\d+[A-Za-z]?)$/, '').replace(/站$/, '');

/** Parse the three CSVs (text) into { stations: [...], lines: {...} }. Exported for the tests. */
export function parseNetwork({ stationsText, exitsText, linesText }) {
  const lines = {};
  for (const r of linesText ? parseCSV(linesText) : []) {
    const id = unq(r.LineID); const [zh, en] = braces(r.LineName);
    if (id) lines[id] = { zh: zh || null, en: en || null, color: unq(r.LineColor) || null };
  }
  const stations = [];
  for (const r of parseCSV(stationsText)) {
    const codes = unq(r.StationID).split(',').map((x) => x.trim()).filter(Boolean);
    const [zh, en] = braces(r.StationName);
    const [lng, lat] = braces(r.StationPosition).map(Number);
    if (!zh || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const address = unq(r.StationAddress).split(/\r?\n/)[0].replace(/^[^：]*：/, '').slice(0, 80) || null;
    const lineIds = [...new Set(codes.map((c) => c.replace(/\d+[A-Z]?$/, '')).filter(Boolean))];
    // one station listed once per line (南港展覽館 BR24 + BL23): one feature with both codes
    const twin = stations.find((s) => s.zh === zh && haversine(s.c, [lng, lat]) < 700);
    if (twin) { twin.codes = [...new Set([...twin.codes, ...codes])]; twin.lines = [...new Set([...twin.lines, ...lineIds])]; continue; }
    stations.push({ codes, zh, en: EN_FIX[en] || en || null, c: [round6(lng), round6(lat)], address, lines: lineIds, entrances: [] });
  }
  if (!stations.length) throw new UserError('Taipei Metro station list parsed to 0 stations (format changed?)');
  const byKey = new Map(stations.map((s) => [stationKey(s.zh), s]));
  const orphan = new Map();
  for (const r of exitsText ? parseCSV(exitsText) : []) {
    const name = r['出入口名稱'], lng = Number(r['經度']), lat = Number(r['緯度']);
    if (!name || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const e = { ref: String(r['出入口編號'] ?? '').trim() || null, c: [round6(lng), round6(lat)], step_free: r['是否為無障礙用'] === '是' };
    const k = stationKey(name);
    const s = byKey.get(k);
    if (s) s.entrances.push(e);
    else { if (!orphan.has(k)) orphan.set(k, []); orphan.get(k).push(e); }
  }
  // stations only in the entrance list (the Circular line): a point at the mean of their entrances, zh name only
  for (const [k, es] of orphan) {
    const c = [round6(es.reduce((a, e) => a + e.c[0], 0) / es.length), round6(es.reduce((a, e) => a + e.c[1], 0) / es.length)];
    stations.push({ codes: [], zh: k, en: null, c, address: null, lines: [], entrances: es, from_entrances: true });
  }
  return { stations, lines };
}

/** The network (cached). Throws when it cannot be had at all (no cache, data.taipei down). */
export async function loadNetwork(ctx) {
  const hit = ctx.cached(CACHE_FILE, CACHE_MAX_H);
  if (hit) { try { const j = JSON.parse(fs.readFileSync(hit, 'utf8')); if (j.stations?.length) return j; } catch {} }
  try {
    const text = async (key) => {
      const S = SOURCES[key];
      const { buf } = await ctx.fetchBuffer(S.url, { label: `data.taipei (${S.dataset})`, timeoutMs: 20000, retries: 1 });
      return decodeTaiwanText(buf).text;
    };
    ctx.log('  Downloading Taipei Metro stations + entrances (data.gov.tw 131734, 128428)…');
    const stationsText = await text('stations');
    const exitsText = await text('exits').catch((e) => { ctx.log(`  (entrances unavailable: ${e.message}; stations only)`); return ''; });
    const linesText = await text('lines').catch(() => '');
    const net = { v: 1, as_of: new Date().toISOString().slice(0, 10), fetched_at: new Date().toISOString(), ...parseNetwork({ stationsText, exitsText, linesText }) };
    fs.writeFileSync(ctx.cachePath(CACHE_FILE), JSON.stringify(net));
    ctx.writeMeta('network', { fetched_at: net.fetched_at, stations: net.stations.length, entrances: net.stations.reduce((a, s) => a + s.entrances.length, 0) });
    return net;
  } catch (e) {
    // a stale copy beats none (stations rarely move)
    try { const j = JSON.parse(fs.readFileSync(ctx.cachePath(CACHE_FILE), 'utf8')); if (j.stations?.length) { ctx.log(`  (data.taipei unavailable: ${e.message}; using the copy from ${j.as_of})`); return j; } } catch {}
    throw e;
  }
}

const near = (s, c) => Math.min(haversine(s.c, c), ...s.entrances.map((e) => haversine(e.c, c)));
/** true when every query point is within COVER_M of a Taipei Metro station (the dataset answers for that area) */
export function covers(net, pts) {
  return pts.length > 0 && pts.every((p) => net.stations.some((s) => near(s, p) <= COVER_M));
}

/** Stations within radiusM of any circle centre (station point or any entrance), or inside a bbox → GeoJSON features */
export function stationFeatures(net, { circles = null, radiusM = 800, bbox = null }) {
  const inBox = (c) => c[0] >= bbox[0] && c[0] <= bbox[2] && c[1] >= bbox[1] && c[1] <= bbox[3];
  const keep = (s) => (circles ? circles.some((p) => near(s, p) <= radiusM) : [s.c, ...s.entrances.map((e) => e.c)].some(inBox));
  const lineNames = (s) => s.lines.map((l) => net.lines?.[l]?.en || net.lines?.[l]?.zh || l).filter(Boolean);
  return net.stations.filter(keep).map((s) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: s.c },
    properties: {
      id: s.codes.length ? `trtc-${s.codes.join('-').toLowerCase()}` : `trtc-${encodeURIComponent(s.zh).replace(/%/g, '').toLowerCase().slice(0, 40)}`,
      name: s.zh, ...(s.en ? { name_en: s.en } : { needs_english: true }), kind: 'mrt_station', emoji: '🚇',
      ...(s.codes.length ? { station_code: s.codes.join(' / ') } : {}),
      ...(s.lines.length ? { lines: s.lines.join(', '), line_names: lineNames(s).join(', ') } : {}),
      ...(s.address ? { address: s.address } : {}),
      ...(s.entrances.length ? { entrances: s.entrances } : {}),
      ...(s.from_entrances ? { position: 'mean of its entrances' } : {}),
      source: SOURCE_LABEL, source_id: SOURCE_ID, lane: 'open', data_licence: 'OGDL-Taiwan-1.0', as_of: net.as_of,
    },
  }));
}

/** Collection-level fields every tw-metro layer file carries (credit, provenance lane). */
export const fileFields = (net) => ({ attribution: ATTRIBUTION, source: { id: SOURCE_ID, label: SOURCE_LABEL, lane: 'open', licence: 'OGDL-Taiwan-1.0', as_of: net.as_of, scope: SCOPE } });

export async function run(ctx, args) {
  const layer = checkLayerId(args.layer || 'mrt');
  const site = ctx.site;
  const r = args.radius ?? 800;
  let circles = null, bbox = null;
  if (args.around) circles = (loadLayer(site, args.around).features || []).filter((f) => f?.geometry?.type === 'Point').map((f) => f.geometry.coordinates);
  else if (args.near) circles = [parseLngLat(args.near, 'near')];
  else if (args.bbox) bbox = parseBBox(args.bbox);
  else bbox = viewBounds(site);
  if (!circles && !bbox) throw new UsageError('give --around <layer> [--radius 800], --near lng,lat or --bbox w,s,e,n (map.config.json has no view.bounds)');
  const net = await loadNetwork(ctx);
  const feats = stationFeatures(net, { circles, radiusM: r, bbox });
  const fc = { type: 'FeatureCollection', ...fileFields(net), features: feats };
  const area = circles ? { around: args.around, near: args.near, radius: r, bbox: (args.around ? layerBBox(site, args.around, r) : bboxAround(circles[0], r)).join(',') } : { bbox: bbox.join(',') };
  const w = ctx.writeOwnedLayer(layer, fc, { args: { kinds: 'mrt_station', source: 'tw-metro', ...area }, force: args.force, coverage: circles ? { circles: circles.map((c) => [c[0], c[1], r]) } : null });
  const wrote = [w.rel];
  if (ctx.addAttribution(ATTRIBUTION)) wrote.push('map.config.json');
  const registered = registerLayer(site, layerHint(site, layer, 'points', { title: 'Metro stations', style: { emoji: '🚇' } }));
  if (registered && !wrote.includes('map.config.json')) wrote.push('map.config.json');
  const lines = [`tw-metro: ${feats.length} Taipei Metro station(s) (${SOURCE_LABEL}, complete for ${SCOPE}): ` +
    feats.slice(0, 8).map((f) => `${f.properties.name}${f.properties.name_en ? ` (${f.properties.name_en})` : ''}`).join(' · ') + (feats.length > 8 ? ' …' : '')];
  if (circles && !covers(net, circles)) lines.push(`  Some points are over ${COVER_M / 1000} km from any Taipei Metro station: other networks (Airport MRT, light rail, Kaohsiung) are not in this dataset; use uw places … --kinds mrt_station --source osm there.`);
  if (registered) lines.push(registered);
  return { summary: lines[0], lines, count: feats.length, wrote, as_of: net.as_of };
}
