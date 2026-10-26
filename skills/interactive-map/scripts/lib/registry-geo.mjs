// Registry-backed geocoding for lodging in Taiwan. OpenStreetMap often lacks small, new or renamed hotels (Everstar =
// the renamed Astar 亞士都; Lore = 樂爾公寓, registered as 院院樂居). Taiwan's national lodging database (data.gov.tw 7780)
// has every licensed hotel and B&B with coordinates as filed by the operator; the Taipei register (data.taipei 135464)
// adds the name the city licensed, linked by licence number. Matching is by name only (official, register, website
// domain, names quoted in the listing's description), so a match says which name matched and how sure it is.
import { haversine, round6, slugify } from './util.mjs';
import { makeAdapterCtx } from './cmd-adapter.mjs';
import { nameSim, hasCJK, halfwidth } from '../adapters/lib/twnorm.mjs';

export const LODGING_RE = /\b(hotels?|hostels?|inns?|motels?|resorts?|guest ?houses?|b ?& ?b|bnb|suites|lodge|ryokan|apartments?|residences?|aparthotel)\b|旅館|飯店|酒店|民宿|旅店|商旅|旅社|行旅|文旅|公寓|會館|客棧|青旅|背包客|膠囊/i;
const LODGING_KIND = /^(hotel|hostel|guest_house|motel|apartment|resort|bnb|chalet|lodging)$/;
const LODGING_LAYER = /^(hotels?|hostels?|stays?|lodging|accommodations?|bnbs?|options?|choices?|candidates?|shortlist|apartments?|homes?)$/i;
// Taiwan incl. Kinmen and Matsu (a coarse box: callers also limit the distance to --near or the map view)
export const TAIWAN_BBOX = [118.1, 21.8, 122.1, 26.4];

export function isLodging({ query = '', kind = null, layer = '' } = {}) {
  return LODGING_RE.test(query) || (kind != null && LODGING_KIND.test(String(kind))) || LODGING_LAYER.test(String(layer || ''));
}
export function inTaiwan(c) {
  return Array.isArray(c) && c[0] >= TAIWAN_BBOX[0] && c[0] <= TAIWAN_BBOX[2] && c[1] >= TAIWAN_BBOX[1] && c[1] <= TAIWAN_BBOX[3];
}
/** a Taiwan place named in text ("Lore Hotel, Taipei", "台北") */
export const TAIWAN_WORDS = /taiwan|taipei|taichung|tainan|kaohsiung|hualien|taitung|hsinchu|keelung|yilan|[臺台]灣|[臺台]北|[臺台]中|[臺台]南|高雄|花蓮/i;
// Is the area this site (or command) works in Taiwan? --near first, else the site's view centre, else its bounds; a
// site with no view yet (built without --center while search was slow): the query or the site's title names Taiwan.
export function areaInTaiwan(site, near, text = '') {
  if (near) return inTaiwan(near);
  const v = site?.config?.view;
  // the starter's world view (no bounds, zoom < 4) says nothing about the area
  if (!v || (!Array.isArray(v.bounds) && !(Number(v.zoom) >= 4))) return TAIWAN_WORDS.test(`${text} ${site?.config?.title || ''}`);
  if (Array.isArray(v?.center) && !(v.center[0] === 0 && v.center[1] === 0) && inTaiwan(v.center)) return true;
  const b = v?.bounds;
  if (Array.isArray(b) && b.length === 2) return inTaiwan([(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]);
  return false;
}

// ---------------------------------------------------------------------------
// Name matching
const GEN = new Set(('the a an of and at in hotel hotels inn hostel hostels motel resort suites suite residence apartment apartments ' +
  'aparthotel guesthouse guest house lodge boutique taipei taiwan tw city branch bnb b roc new').split(' '));
const AFFIX = ['taipei', 'taiwan', 'hotels', 'hotel', 'hostel', 'house', 'suites', 'inn', 'the', 'tw', 'boutique', 'resort', 'travel'];
const HOSTS = /^(facebook|fb|instagram|booking|agoda|google|goo|line|lin|linktr|wixsite|blogspot|pixnet|weebly|wordpress|airbnb|trivago|hotels|expedia|tripadvisor|asiayo|eztravel|bit|reurl|ppt|youtube|x|twitter|trip|klook|kkday|owlting|siteminder|ezhotel)$/i;
const TLD = /^(com|net|org|tw|idv|gov|edu|biz|info|co|travel|asia|cc|me|io|jp|hk|cn|xyz|site|online|top|app)$/i;

function latinTokens(s) {
  return (halfwidth(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || []).filter((t) => !GEN.has(t));
}
// "https://www.TaipeiEverStar.com" → "taipeieverstar"; booking / social / link-shortener hosts → null
export function webCore(url) {
  if (!url) return null;
  let host;
  try { host = new URL(/^https?:\/\//i.test(url) ? url : 'http://' + url).hostname.toLowerCase(); } catch { return null; }
  const labels = host.split('.').filter((l) => l && l !== 'www' && l !== 'm');
  while (labels.length > 1 && TLD.test(labels[labels.length - 1])) labels.pop();
  const core = labels[labels.length - 1];
  if (!core || core.length < 3 || HOSTS.test(core) || labels.some((l) => HOSTS.test(l))) return null;
  return core.replace(/[^a-z0-9]/g, '');
}
function stripAffix(core) {
  let s = core, changed = true;
  while (changed && s) {
    changed = false;
    for (const w of AFFIX) {
      if (s.length > w.length + 1 && s.startsWith(w)) { s = s.slice(w.length); changed = true; }
      if (s.length > w.length + 1 && s.endsWith(w)) { s = s.slice(0, -w.length); changed = true; }
    }
  }
  return s;
}
// The part of a query that names the place ("Everstar Hotel, Taipei" → "Everstar Hotel").
export function queryLabel(q) {
  const first = String(q || '').split(/[,，、]/)[0].trim();
  return first || String(q || '').trim();
}

// Similarity 0-1 between a query and one alias. `on` = what the alias is (name, register, website, description).
export function aliasSim(query, alias, on = 'name') {
  if (!alias) return 0;
  const label = queryLabel(query);
  let qt = latinTokens(label);
  if (!qt.length && !hasCJK(label)) qt = latinTokens(query);
  if (on === 'website') {
    const q = qt.join('');
    if (!q) return 0;
    const d = stripAffix(alias);
    if (d === q || alias === q) return 1;
    return q.length >= 5 && d.includes(q) ? 0.7 : 0;
  }
  let s = 0;
  if (hasCJK(label) && hasCJK(alias)) s = nameSim(label, alias);
  const at = latinTokens(alias);
  if (qt.length && at.length) {
    const A = new Set(at), Q = new Set(qt);
    const qin = [...Q].every((t) => A.has(t)), ain = [...A].every((t) => Q.has(t));
    const l = qin && ain ? 1 : qin ? 0.85 : ain ? 0.75 : ([...Q].filter((t) => A.has(t)).length / Math.max(Q.size, A.size)) * 0.6;
    s = Math.max(s, l);
  }
  return Math.round(s * 100) / 100;
}

// Taipei's districts in the form Photon/OSM uses in English, so registry points read like the others on cards
const DISTRICT_EN = { 中正區: 'Zhongzheng District', 大同區: 'Datong District', 中山區: 'Zhongshan District', 松山區: 'Songshan District',
  大安區: "Da'an District", 萬華區: 'Wanhua District', 信義區: 'Xinyi District', 士林區: 'Shilin District', 北投區: 'Beitou District',
  內湖區: 'Neihu District', 南港區: 'Nangang District', 文山區: 'Wenshan District' };
const ON_LABEL = { name: 'registered name', alt: 'alternate name', register: 'Taipei register name', website: 'website', description: 'name in the listing' };

// ---------------------------------------------------------------------------
// Search
// near: [lng,lat] | null; inRange(cand) → bool (default: within maxKm of near, or anywhere when no near).
export async function registrySearch(query, { near = null, maxKm = 8, inRange = null, limit = 5, log = () => {}, ctx = null } = {}) {
  const { loadDB, normLic, NATIONAL, TAIPEI } = await import('../adapters/tw-hotels.mjs');
  ctx ||= makeAdapterCtx({ name: 'tw-hotels', log });
  const db = await loadDB(ctx);
  const within = inRange || ((c) => !near || c.distance_km <= maxKm);
  const found = [];
  const coordCount = new Map();
  for (const r of db.national.rows) {
    if (r.lng == null || r.lat == null) continue;
    const k = `${r.lng.toFixed(5)},${r.lat.toFixed(5)}`;
    coordCount.set(k, (coordCount.get(k) || 0) + 1);
  }
  for (const r of db.national.rows) {
    if (r.lng == null || r.lat == null) continue;
    const coord = [round6(r.lng), round6(r.lat)];
    const distance_km = near ? Math.round(haversine(near, coord) / 10) / 100 : null;
    const cand0 = { coord, distance_km };
    if (near && distance_km > Math.max(maxKm, 60)) continue; // cheap prefilter
    const reg = r.lic ? db.regByLic.get(normLic(r.lic)) : null;
    const aliases = [{ on: 'name', text: r.name }, ...(r.alt || []).map((t) => ({ on: 'alt', text: t })),
      ...(reg && reg.name !== r.name ? [{ on: 'register', text: reg.name }] : []),
      ...(webCore(r.web) ? [{ on: 'website', text: webCore(r.web), shown: r.web }] : []),
      ...(r.dq || []).map((t) => ({ on: 'description', text: t }))];
    const hits = aliases.map((a) => ({ ...a, sim: aliasSim(query, a.text, a.on) })).filter((a) => a.sim >= 0.5).sort((a, b) => b.sim - a.sim);
    if (!hits.length) continue;
    if (!within(cand0)) continue;
    const cls = Array.isArray(r.cls) ? r.cls[0] : r.cls;
    const kind = Number(cls) === 4 ? 'guest_house' : 'hotel';
    found.push({
      name: r.name, name_local: reg?.name && reg.name !== r.name ? reg.name : null, type: `registry=${kind}`, kind, address: r.address, coord, distance_km,
      osm_id: null, district: r.town || null, city: r.city || null, source: 'registry', sim: hits[0].sim,
      registry: { dataset: NATIONAL.id, dataset_url: NATIONAL.page, register: reg ? TAIPEI.id : null, hotel_id: r.id, licence_id: reg?.lic || r.lic || null,
        register_name: reg?.name || null, register_address: reg?.address || null, website: r.web || null, open: r.status == null || Number(r.status) === 1,
        rooms: r.rooms ?? null, matched: hits.filter((h) => h.sim >= hits[0].sim - 0.05).map((h) => ({ on: h.on, text: h.shown || h.text, sim: h.sim })),
        coord_shared: coordCount.get(`${r.lng.toFixed(5)},${r.lat.toFixed(5)}`) || 1,
        as_of: db.national.as_of || null, register_as_of: db.register?.as_of || null },
    });
  }
  found.sort((a, b) => b.sim - a.sim || (b.registry.open - a.registry.open) || (a.distance_km ?? 0) - (b.distance_km ?? 0));
  // confidence: exact on the registered / register name = high; exact on website or description = medium, high when
  // two kinds of alias agree; another place as similar but elsewhere (> 150 m: a chain's branches) caps it at low
  for (const c of found) {
    const kinds = new Set(c.registry.matched.filter((m) => m.sim >= 0.95).map((m) => m.on));
    const rivals = found.filter((o) => o !== c && o.sim >= c.sim - 0.1 && haversine(o.coord, c.coord) > 150);
    const exact = c.sim >= 0.95;
    let conf = exact && (kinds.has('name') || kinds.has('alt') || kinds.has('register') || kinds.size >= 2) ? 'high' : exact || c.sim >= 0.75 ? 'medium' : 'low';
    if (rivals.length) conf = 'low';
    if (!c.registry.open && conf === 'high') conf = 'medium';
    c.confidence = conf;
    c.by = [...kinds].length ? [...kinds] : [c.registry.matched[0]?.on].filter(Boolean);
  }
  // register rows that match by name but have no national row (no coordinates): reported, never placed
  const unplaced = [];
  const linked = new Set(db.national.rows.map((r) => r.lic && normLic(r.lic)).filter(Boolean));
  if (!near || (near[0] > 121.4 && near[0] < 121.7 && near[1] > 24.9 && near[1] < 25.25)) {
    for (const r of db.register?.rows || []) {
      if (r.lic && linked.has(normLic(r.lic))) continue;
      const sim = aliasSim(query, r.name, 'register');
      if (sim >= 0.75) unplaced.push({ name: r.name, address: r.address, licence_id: r.lic || null, sim, register: TAIPEI.id });
    }
  }
  return { candidates: found.slice(0, limit), total: found.length, unplaced: unplaced.slice(0, 3),
    as_of: db.national.as_of, register_as_of: db.register?.as_of || null, national_rows: db.national.rows.length };
}

// The candidate add-point may take on its own: high or medium, not closed (closed listings need --pick).
export function acceptable(c) { return !!c && (c.confidence === 'high' || c.confidence === 'medium') && c.registry?.open !== false; }

export function fmtRegistryCand(c, i) {
  const m = c.registry.matched.map((x) => `${ON_LABEL[x.on] || x.on} "${x.text}"`).join(' + ');
  return `${i + 1}. ${c.name}${c.name_local ? ` / ${c.name_local}` : ''} [${c.type}] — ${c.address} @ ${c.coord.join(',')}` +
    `${c.distance_km != null ? ` (${c.distance_km} km away)` : ''} · licence ${c.registry.licence_id || '—'} · matched ${m} · ${c.confidence}` +
    `${c.registry.open ? '' : ' · NOT OPERATING per register'}`;
}

// Feature properties for a registry match. label = the name the user asked for (kept as the map's name).
export function registryProps(c, { label, now = new Date().toISOString() } = {}) {
  const r = c.registry;
  const props = {};
  props.name = label || c.name;
  const latin = /[A-Za-z]/.test(props.name) && !hasCJK(props.name);
  if (latin) props.name_en = props.name;
  const local = c.name_local || c.name;
  if (local && local !== props.name) props.name_local = local;
  const aka = [c.name, c.name_local].filter((x) => x && x !== props.name && x !== props.name_local);
  if (aka.length) props.aka = aka;
  props.kind = c.kind;
  props.address = String(c.address || '').split('、')[0];
  if (c.district) { props.area = DISTRICT_EN[c.district] || c.district; if (DISTRICT_EN[c.district]) props.area_local = c.district; }
  if (r.website) props.website = r.website;
  props.source = r.register ? 'Taiwan lodging registers (data.gov.tw 7780 · Taipei 135464)' : 'Taiwan lodging database (data.gov.tw 7780)';
  props.tw_hotel_id = r.hotel_id;
  if (r.licence_id) props.tw_licence_id = r.licence_id;
  props.prov = {
    source: r.dataset, source_label: 'Taiwan lodging database (Tourism Administration)', lane: 'open', url: r.dataset_url,
    ...(r.register ? { also: r.register } : {}), as_of: r.as_of || undefined, observed_at: now, observed_by: 'uw add-point',
    coord_basis: 'as filed by the operator (PositionLat/PositionLon)', license: 'OGDL-Taiwan-1.0',
    match: { confidence: c.confidence, by: c.by, on: r.matched.map((m) => `${m.on}:${m.text}`).slice(0, 3), sim: c.sim, candidate: c.name },
  };
  return JSON.parse(JSON.stringify(props));
}

export function slugFor(label, c) { return slugify(label) || slugify(c?.name_en || '') || (c?.registry?.hotel_id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
