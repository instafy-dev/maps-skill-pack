// tw-hotels: Taiwan's official lodging registers → licence chip, registered rooms and FILED rates (not prices).
//   national 旅館民宿 DB (data.gov.tw 7780, Tourism Administration, daily, with coordinates and licence numbers)
//   Taipei 一般旅館名冊 (data.gov.tw 135464, Taipei City Government, no coordinates)
// Matching uses explicit signals (phone, address, name, geo) and a confidence level. A miss is "not found in register":
// never "illegal" or "unlicensed". A low/medium match is "uncertain", never "registered".
import fs from 'node:fs';
import { readJSON, writeJSON, haversine, representativePoint, bboxAround, UsageError, UserError } from '../lib/util.mjs';
import { checkLayerId, configLayer } from '../lib/site.mjs';
import { rid } from '../lib/records.mjs';
import { unzipOne } from '../lib/zip.mjs';
import { decodeTaiwanText, parseCSV } from '../lib/cmd-adapter.mjs';
import { parseAddress, addressKey, normPhones, formatAddress, hasLatin, normName } from './lib/twnorm.mjs';
import { bestMatch, scoreCandidate, confRank } from './lib/match.mjs';

export const VERSION = 'tw-hotels@0.2';
export const NATIONAL = {
  id: 'data.gov.tw/7780', dataset: 7780, label: 'Taiwan lodging database (Tourism Administration)',
  url: 'https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Hotel-json.zip', page: 'https://data.gov.tw/dataset/7780',
  licenceAttribution: '交通部觀光署 (OGDL-Taiwan-1.0)',
};
export const TAIPEI = {
  id: 'data.taipei/135464', dataset: 135464, label: 'Taipei hotel register',
  url: 'https://data.taipei/api/dataset/4d7d0b46-2e90-4ee7-b000-c0f2f3a37651/resource/3cea29db-66b1-4ab5-886c-4cafd3e1dcbc/download',
  page: 'https://data.gov.tw/dataset/135464', licenceAttribution: '臺北市政府 (OGDL-Taiwan-1.0)',
};
export const ATTRIBUTION = '旅館資料：交通部觀光署、臺北市政府 (data.gov.tw，政府資料開放授權條款第1版)';
const LIC_RE = /(\S{2,3}[市縣])?(觀光)?旅館\d+號|民宿\d+號|交觀業字第\d+號/;

export const meta = {
  name: 'tw-hotels',
  describe: 'Taiwan hotel/B&B registers (data.gov.tw 7780 + Taipei 135464): licence, rooms, filed min/max rates, with match confidence',
  sources: [
    { id: NATIONAL.id, licence: 'OGDL-Taiwan-1.0', url: NATIONAL.page },
    { id: TAIPEI.id, licence: 'OGDL-Taiwan-1.0', url: TAIPEI.page },
  ],
  flags: { layer: 'string', radius: 'number', records: 'bool' },
  help: `adapter tw-hotels <site> --layer hotels [--radius 300] [--records] [--refresh] [--json]
  Matches every feature of --layer against Taiwan's national lodging database (data.gov.tw 7780, daily, with
  coordinates) and the Taipei hotel register (data.gov.tw 135464). Signals: phone (exact), address (road + section +
  number), name (bigram similarity ≥ 0.5, zh + en + aka) and geo (≤ 60 m). Confidence: high = (phone or address) and
  (name or geo); medium = name ≥ 0.6 within 150 m, or address alone; low = name ≥ 0.4 ("possibly").
  Writes per feature: tw_hotel_id, tw_register, tw_rooms, tw_price_min, tw_price_max (TWD, FILED rates: the legal
  ceiling a hotel registered, not a price you can book), tw_class, tw_match, tw_as_of and a generic "licence" object
  (status registered | uncertain | not_found). metrics.json: tw_rooms (registry), tw_price_max (filed).
  --records also writes data/records/tw-hotels.json claims (licence, registered_rooms, filed_price_min/max).
  Appends the mandatory OGDL credit to map.config.json "attribution" (the licence is void without it).
  Datasets are cached in the shared cache's tw-hotels/ (UW_CACHE, else INSTAFY_CACHE_DIR, else ~/.cache/uw) for 24 h (--refresh downloads again).`,
};

// ---------------------------------------------------------------------------
// Datasets
const CLASS = { 1: { zh: '觀光旅館', key: 'tourist_hotel', note: 'international tourist hotel' }, 2: { zh: '觀光旅館', key: 'tourist_hotel', note: 'tourist hotel' },
  3: { zh: '一般旅館', key: 'hotel' }, 4: { zh: '民宿', key: 'bnb' } };
export const LABEL = { hotel: 'Registered hotel', tourist_hotel: 'Registered tourist hotel', bnb: 'Registered B&B' };

function names(x) {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : [x];
  return arr.map((a) => (typeof a === 'string' ? a : a?.Name || a?.name || a?.Value || '')).filter(Boolean);
}

// v2 of the compact cache adds "dq" (lodging names quoted in Description, e.g. 「樂爾公寓 LORE HOTEL」: a brand the
// registered name does not carry). An older cache is rebuilt from the cached zip, without downloading again.
const NATIONAL_CACHE_V = 2;
export async function loadNational(ctx) {
  const compact = ctx.cached('national.json');
  if (compact) { try { const d = readJSON(compact); if (d.rows?.length && d.v === NATIONAL_CACHE_V) return d; } catch {} }
  const zipHit = ctx.cached('Hotel-json.zip');
  if (zipHit) {
    try {
      const prev = (() => { try { return readJSON(ctx.cachePath('national.json')); } catch { return null; } })();
      return parseNational(ctx, fs.readFileSync(zipHit), { url: prev?.source_url || NATIONAL.url, as_of: prev?.as_of || null });
    } catch { /* re-download below */ }
  }
  ctx.log(`  Downloading the national lodging database (data.gov.tw 7780, ~5 MB)…`);
  const { metaDs, buf, url } = await download(ctx, NATIONAL, (d) => /Hotel-json\.zip$/i.test(d.url || ''), 'media.taiwan.net.tw (data.gov.tw 7780)', 180000);
  fs.writeFileSync(ctx.cachePath('Hotel-json.zip'), buf);
  return parseNational(ctx, buf, { url, as_of: metaDs?.updated || null });
}
const QUOTE_RE = /[「『“"]([^」』”"\n]{2,30})[」』”"]/g;
const LODGING_WORD = /旅|店|館|宿|寓|居|棧|hotel|hostel|inn\b|suites|apartment|residence/i;
function parseNational(ctx, buf, { url, as_of }) {
  const { data } = unzipOne(buf, /HotelList\.json$/i);
  let txt = data.toString('utf8');
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  const j = JSON.parse(txt);
  const list = j.Hotels || j.HotelList || j.XML_Head?.Infos?.Info || [];
  if (!Array.isArray(list) || !list.length) throw new UserError('data.gov.tw 7780: HotelList.json has no hotels (the format may have changed)');
  const rows = list.map((h) => {
    const pa = h.PostalAddress || {};
    const street = typeof pa === 'string' ? pa : `${pa.City || ''}${pa.Town || ''}${pa.StreetAddress || ''}`;
    let lic = typeof h.HotelLicenseNumber === 'string' && h.HotelLicenseNumber.trim() ? h.HotelLicenseNumber.trim() : null, licField = lic ? 'HotelLicenseNumber' : null;
    if (!lic) {
      for (const [k, v] of Object.entries(h)) {
        if (k === 'HotelName' || k === 'Description') continue;
        const s = typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : '';
        const m = s.match(LIC_RE);
        if (m) { lic = m[0]; licField = k; break; }
      }
    }
    const lat = Number(h.PositionLat), lng = Number(h.PositionLon);
    const dq = [...new Set([...String(h.Description || '').matchAll(QUOTE_RE)].map((m) => m[1].trim()).filter((x) => LODGING_WORD.test(x)))].slice(0, 3);
    return {
      id: h.HotelID, lic, licField, name: h.HotelName || '', alt: names(h.AlternateNames),
      lat: Number.isFinite(lat) && lat ? lat : null, lng: Number.isFinite(lng) && lng ? lng : null,
      cls: Array.isArray(h.HotelClasses) ? h.HotelClasses[0] : h.HotelClasses ?? null,
      city: pa.City || null, town: pa.Town || null, address: street,
      phones: normPhones(h.Telephones || []), rooms: num(h.TotalRooms), pmin: num(h.LowestPrice), pmax: num(h.CeilingPrice),
      status: h.ServiceStatus ?? null, web: h.WebsiteURL || null, upd: h.UpdateTime || null, ...(dq.length ? { dq } : {}),
    };
  });
  const out = { v: NATIONAL_CACHE_V, as_of: String(j.UpdateTime || as_of || '').slice(0, 10) || null, fetched_at: new Date().toISOString(), source_url: url, rows };
  writeJSON(ctx.cachePath('national.json'), out);
  ctx.writeMeta('national', { fetched_at: out.fetched_at, source_updated: out.as_of, url, rows: rows.length });
  return out;
}
// Download a dataset: the URL listed by the data.gov.tw API (looked up in parallel; cached 24 h) or the known one.
// When the known URL fails, the API's current URL is tried, so a moved resource still resolves.
async function download(ctx, S, pick, label, timeoutMs) {
  const cachedMeta = ctx.cached(`datagovtw-${S.dataset}.json`) ? await ctx.dataGovTw(S.dataset) : null;
  const first = cachedMeta?.distribution?.find(pick)?.url || S.url;
  const metaP = cachedMeta ? Promise.resolve(cachedMeta) : ctx.dataGovTw(S.dataset);
  try {
    const [metaDs, dl] = await Promise.all([metaP, ctx.fetchBuffer(first, { label, timeoutMs })]);
    return { metaDs, buf: dl.buf, url: first };
  } catch (e) {
    const metaDs = await metaP;
    const alt = metaDs?.distribution?.find(pick)?.url;
    if (!alt || alt === first) throw e;
    ctx.log(`  ${label}: ${e.message}; trying the URL data.gov.tw lists now (${alt})`);
    const dl = await ctx.fetchBuffer(alt, { label, timeoutMs });
    return { metaDs, buf: dl.buf, url: alt };
  }
}
const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };

export async function loadTaipeiRegister(ctx) {
  const compact = ctx.cached('taipei-register.json');
  if (compact) { try { const d = readJSON(compact); if (d.rows?.length) return d; } catch {} }
  ctx.log('  Downloading the Taipei hotel register (data.gov.tw 135464)…');
  const { metaDs, buf, url } = await download(ctx, TAIPEI, (d) => /data\.taipei/.test(d.url || ''), 'data.taipei (135464)', 60000);
  const { text, encoding } = decodeTaiwanText(buf);
  let recs;
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) { const j = JSON.parse(t); recs = Array.isArray(j) ? j : j.result?.results || j.data || []; }
  else recs = parseCSV(text);
  const pick = (r, ...ks) => { for (const k of ks) if (r[k] !== undefined && r[k] !== '') return r[k]; return ''; };
  const rows = recs.map((r) => ({
    lic: pick(r, '專用標識編號', 'license'), name: pick(r, '旅館名稱', 'name'), phones: normPhones(pick(r, '電話或手機號碼', '電話')),
    address: pick(r, '營業地址', '地址'), pmin: num(pick(r, '客房最低定價')), pmax: num(pick(r, '客房最高定價')), rooms: num(pick(r, '房間數')),
  })).filter((r) => r.name);
  if (!rows.length) throw new UserError('data.taipei 135464: the register parsed to 0 rows (format changed?)');
  const out = { as_of: metaDs?.updated || null, fetched_at: new Date().toISOString(), source_url: url, encoding, rows };
  writeJSON(ctx.cachePath('taipei-register.json'), out);
  ctx.writeMeta('taipei-register', { fetched_at: out.fetched_at, source_updated: out.as_of, url, rows: rows.length, encoding });
  return out;
}

let MEMO = null; // one process (a handler run) loads the datasets once
export async function loadDB(ctx, { onStep } = {}) {
  if (MEMO && !ctx.refresh) return MEMO;
  onStep?.(1);
  // both downloads in parallel (cold start ≈ the slower of the two)
  const regP = loadTaipeiRegister(ctx).catch((e) => { ctx.log(`  (Taipei register unavailable: ${e.message}; using the national database only)`); return null; });
  const national = await loadNational(ctx);
  onStep?.(2);
  const register = await regP;
  for (const r of national.rows) { r._addr = parseAddress(r.address); }
  const regByAddr = new Map(), regByPhone = new Map(), regByLic = new Map();
  for (const r of register?.rows || []) {
    r._addr = parseAddress(r.address);
    const k = addressKey(r._addr); if (k) (regByAddr.get(k) || regByAddr.set(k, []).get(k)).push(r);
    for (const p of r.phones) (regByPhone.get(p) || regByPhone.set(p, []).get(p)).push(r);
    if (r.lic) regByLic.set(normLic(r.lic), r);
  }
  MEMO = { national, register, regByAddr, regByPhone, regByLic };
  return MEMO;
}
export const normLic = (s) => String(s || '').replace(/台/g, '臺').replace(/\s+/g, '').replace(/第?0*(\d+)號/, '$1號');

// ---------------------------------------------------------------------------
// Matching one feature
function targetOf(props, coord) {
  const nm = [props.name, props.name_en, props.name_local, props.short, ...(Array.isArray(props.aka) ? props.aka : [props.aka])].filter(Boolean)
    .map((s) => String(s).replace(/\(.*?\)|（.*?）/g, '').trim());
  // "aka" often holds prose ("Astar Hotel (亞士都飯店), the old name"): pull bracketed names out too
  for (const s of [props.aka].flat().filter(Boolean)) for (const m of String(s).matchAll(/[（(]([^)）]+)[)）]/g)) nm.push(m[1]);
  const addrs = [props.address_zh, props.address, props.addr, props['addr:full']].filter(Boolean).map(parseAddress).filter((a) => a?.road);
  return { names: [...new Set(nm)], phones: normPhones([props.phone, props.tel, props['contact:phone']].filter(Boolean)), addr: addrs[0] || null, addrs, coord };
}

export function matchFeature(db, props, coord, { radius = 300 } = {}) {
  const target = targetOf(props, coord);
  const box = coord ? bboxAround(coord, radius) : null;
  const natCands = [];
  for (const r of db.national.rows) {
    const near = box && r.lng != null && r.lng >= box[0] && r.lng <= box[2] && r.lat >= box[1] && r.lat <= box[3] && haversine(coord, [r.lng, r.lat]) <= radius;
    const sameAddr = target.addr && r._addr?.road === target.addr.road && r._addr?.number === target.addr.number;
    const samePhone = target.phones.length && r.phones.some((p) => target.phones.includes(p));
    if (near || sameAddr || samePhone) natCands.push({ row: r, names: [r.name, ...r.alt], phones: r.phones, addr: r._addr, coord: r.lng != null ? [r.lng, r.lat] : null });
  }
  // multiple addresses on a feature: score each and keep the best
  const tryAll = (cands) => {
    let best = null;
    for (const addr of target.addrs.length ? target.addrs : [null]) {
      const m = bestMatch({ ...target, addr }, cands);
      if (m && (!best || m.score > best.score)) best = m;
    }
    return best;
  };
  const nat = tryAll(natCands);
  const regCands = [];
  const seen = new Set();
  const addReg = (r) => { if (r && !seen.has(r)) { seen.add(r); regCands.push({ row: r, names: [r.name], phones: r.phones, addr: r._addr, coord: null }); } };
  for (const a of target.addrs) for (const r of db.regByAddr.get(addressKey(a)) || []) addReg(r);
  for (const p of target.phones) for (const r of db.regByPhone.get(p) || []) addReg(r);
  // register rows whose licence the national match already names (address formats differ between the two sources)
  if (nat?.cand.row.lic) addReg(db.regByLic.get(normLic(nat.cand.row.lic)));
  for (const r of db.register?.rows || []) if (target.addr && r._addr?.road === target.addr.road && r._addr?.number === target.addr.number) addReg(r);
  let reg = tryAll(regCands);
  if (nat?.cand.row.lic && confRank(nat.confidence) >= 2) {
    const viaLic = db.regByLic.get(normLic(nat.cand.row.lic));
    if (viaLic && (!reg || reg.cand.row !== viaLic)) {
      const s = scoreCandidate({ ...target, coord: null }, { names: [viaLic.name], phones: viaLic.phones, addr: viaLic._addr, coord: null });
      reg = { ...s, by: [...new Set(['id', ...s.by])], confidence: nat.confidence, cand: { row: viaLic } };
    } else if (viaLic && reg && reg.cand.row === viaLic && !reg.by.includes('id')) reg = { ...reg, by: ['id', ...reg.by], confidence: confRank(reg.confidence) >= confRank(nat.confidence) ? reg.confidence : nat.confidence };
  }
  return combine(db, nat, reg);
}

function combine(db, nat, reg) {
  const confOf = (m) => m?.confidence || 'none';
  const best = confRank(confOf(reg)) > confRank(confOf(nat)) ? reg : nat || reg;
  const confidence = Math.max(confRank(confOf(nat)), confRank(confOf(reg)));
  const conf = ['none', 'low', 'medium', 'high'][confidence];
  if (!best || conf === 'none') return { confidence: 'none', status: 'not_found', registers: [] };
  const n = nat && confOf(nat) !== 'none' ? nat.cand.row : null;
  const r = reg && confOf(reg) !== 'none' ? reg.cand.row : null;
  const registers = [r && 'taipei-135464', n && 'national-7780'].filter(Boolean);
  const cls = n?.cls != null ? CLASS[n.cls] : r ? CLASS[3] : null;
  const lic = r?.lic || n?.lic || null;
  const by = [...new Set([...(reg?.by || []), ...(nat?.by || [])])];
  const dist = nat?.dist_m ?? null;
  // filed facts: the register when it matched (it is the licensing authority's own list), else the national DB
  const src = r && confRank(confOf(reg)) >= confRank(confOf(nat)) ? 'register' : n ? 'national' : 'register';
  const facts = src === 'register' && r ? r : n || r;
  return {
    confidence: conf, status: conf === 'high' ? 'registered' : 'uncertain', registers, by, dist_m: dist,
    candidate: (r?.name || n?.name || '').slice(0, 120), licence_id: lic, licence_from: r?.lic ? 'taipei-135464' : n?.licField ? `national-7780:${n.licField}` : null,
    hotel_id: n?.id || null, class: cls?.key || null, class_zh: cls?.zh || null,
    rooms: facts?.rooms ?? null, price_min: facts?.pmin ?? null, price_max: facts?.pmax ?? null, facts_from: src,
    as_of: src === 'register' ? db.register?.as_of : db.national.as_of, national_as_of: db.national.as_of, register_as_of: db.register?.as_of || null,
    national: n ? { id: n.id, name: n.name, lic: n.lic, address: n.address, lnglat: n.lng != null ? [n.lng, n.lat] : null, web: n.web } : null,
    register: r ? { lic: r.lic, name: r.name, address: r.address } : null,
  };
}

const fmtDate = (d) => d || null;
export function licenceObject(m) {
  const src = 'data.gov.tw 7780 · Taipei register 135464';
  if (m.status === 'not_found') return { status: 'not_found', label: 'Not found in register', source: src, as_of: fmtDate(m.as_of), url: TAIPEI.page, confidence: 'medium' };
  return {
    status: m.status, id: m.licence_id || undefined, label: m.status === 'registered' ? LABEL[m.class || 'hotel'] : `Possibly ${m.licence_id || 'registered'}`,
    class: m.class || 'hotel', source: m.registers.map((x) => (x === 'taipei-135464' ? 'Taipei register 135464' : 'data.gov.tw 7780')).join(' · '),
    as_of: fmtDate(m.as_of), url: m.registers.includes('taipei-135464') ? TAIPEI.page : NATIONAL.page, confidence: m.confidence,
  };
}

// Claims for one matched (or missed) item. ref = "<layer>:<id>".
export function claimsFor(ref, m, { observedBy = 'uw-adapter', now = new Date().toISOString() } = {}) {
  const key = ref.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const useReg = m.registers?.includes('taipei-135464') && (m.facts_from === 'register' || !m.registers.includes('national-7780'));
  const prov = (fromReg) => {
    const S = fromReg ? TAIPEI : NATIONAL;
    return { source: S.id, source_label: S.label, lane: 'open', url: S.page, observed_at: now, observed_by: observedBy,
      as_of: String((fromReg ? m.register_as_of : m.national_as_of) || m.as_of || '').slice(0, 32) || undefined, ttl_s: 0, refresh_days: 45, class: 'stored',
      license: { store: 'full', attribution: S.licenceAttribution }, adapter: VERSION };
  };
  const clean = (o) => JSON.parse(JSON.stringify(o));
  const match = m.confidence && m.confidence !== 'none'
    ? { confidence: m.confidence, by: m.by.filter((b) => ['id', 'phone', 'address', 'name', 'geo'].includes(b)).slice(0, 5), ...(m.dist_m != null ? { dist_m: m.dist_m } : {}), ...(m.candidate ? { candidate: m.candidate } : {}) }
    : undefined;
  const out = [];
  if (m.status === 'not_found') {
    // both registers were checked: one "not found" per register, each under its own source
    for (const fromReg of [true, false]) out.push(clean({ type: 'claim', cid: rid('clm_tw', key, 'licence', fromReg ? 'reg' : 'nat'), ref, attr: 'licence', value: null, status: 'not_found', label: 'Hotel licence',
      note: `Not found in the ${fromReg ? 'Taipei hotel register' : 'national lodging database'} (checked)`, basis: 'registry', confidence: 'medium', prov: prov(fromReg) }));
    return out;
  }
  // one licence claim per register that has the hotel, each with the holder name that register uses (they can differ:
  // a renamed holder in one, the old name in the other), so the map can show both instead of silently picking one
  const st = m.status === 'registered' ? 'ok' : 'uncertain';
  const note = m.status !== 'registered' ? { note: `possible match (${m.confidence}); check before relying on it` } : {};
  const regLic = m.register?.lic || (m.licence_from === 'taipei-135464' ? m.licence_id : null);
  const natLic = m.national?.lic || (m.licence_from && m.licence_from.startsWith('national') ? m.licence_id : null);
  if (regLic) out.push(clean({ type: 'claim', cid: rid('clm_tw', key, 'licence'), ref, attr: 'licence', value: regLic, status: st, label: 'Hotel licence', ...note,
    basis: 'registry', confidence: m.confidence, match: match ? { ...match, candidate: (m.register?.name || match.candidate || '').slice(0, 120) || undefined } : undefined, prov: prov(true) }));
  if (natLic) out.push(clean({ type: 'claim', cid: rid('clm_tw', key, 'licence', 'nat'), ref, attr: 'licence', value: natLic, status: st, label: 'Hotel licence', ...note,
    basis: 'registry', confidence: m.confidence, match: match ? { ...match, candidate: (m.national?.name || match.candidate || '').slice(0, 120) || undefined } : undefined, prov: prov(false) }));
  if (!regLic && !natLic) out.push(clean({ type: 'claim', cid: rid('clm_tw', key, 'licence'), ref, attr: 'licence', value: m.licence_id, status: st, label: 'Hotel licence', ...note,
    basis: 'registry', confidence: m.confidence, match, prov: prov(m.licence_from === 'taipei-135464') }));
  if (confRank(m.confidence) >= 2) {
    if (m.rooms != null) out.push(clean({ type: 'claim', cid: rid('clm_tw', key, 'rooms'), ref, attr: 'registered_rooms', value: m.rooms, unit: 'rooms',
      label: 'Registered rooms', basis: 'registry', confidence: m.confidence, match, prov: prov(useReg) }));
    if (m.price_min != null) out.push(clean({ type: 'claim', cid: rid('clm_tw', key, 'pmin'), ref, attr: 'filed_price_min', value: m.price_min, unit: 'TWD',
      label: 'Filed min rate', note: 'filed min rate, not a live price', basis: 'filed', confidence: m.confidence, match, prov: prov(useReg) }));
    if (m.price_max != null) out.push(clean({ type: 'claim', cid: rid('clm_tw', key, 'pmax'), ref, attr: 'filed_price_max', value: m.price_max, unit: 'TWD',
      label: 'Filed max rate', note: 'filed max rate, not a live price', basis: 'filed', confidence: m.confidence, match, prov: prov(useReg) }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// For handlers
export async function lookup(ctx, { feature, props, lnglat, radius = 300, onStep }) {
  const db = await loadDB(ctx, { onStep });
  const p = props || feature?.properties || {};
  const c = lnglat || (feature?.geometry ? representativePoint(feature.geometry) : null);
  return { match: matchFeature(db, p, c, { radius }), db: { national_as_of: db.national.as_of, register_as_of: db.register?.as_of || null, national_rows: db.national.rows.length, register_rows: db.register?.rows.length || 0 } };
}

// Registered lodging with coordinates within radius_m of at, open (ServiceStatus 1 when present), nearest first.
export async function nearby(ctx, { at, radius_m = 600, max = 15, skip = new Set(), onStep }) {
  const db = await loadDB(ctx, { onStep });
  const box = bboxAround(at, radius_m);
  const list = [];
  let skipped = 0;
  for (const r of db.national.rows) {
    if (r.lng == null || r.lng < box[0] || r.lng > box[2] || r.lat < box[1] || r.lat > box[3]) continue;
    if (r.status != null && Number(r.status) !== 1) continue;
    const d = haversine(at, [r.lng, r.lat]);
    if (d > radius_m) continue;
    if (skip.has(r.id)) { skipped++; continue; }
    const reg = r.lic ? db.regByLic.get(normLic(r.lic)) : null;
    const cls = CLASS[r.cls] || CLASS[3];
    list.push({ row: r, dist: Math.round(d), reg, cls });
  }
  list.sort((a, b) => a.dist - b.dist);
  return { total: list.length, skipped, items: list.slice(0, max), national_as_of: db.national.as_of, register_as_of: db.register?.as_of || null };
}

// ---------------------------------------------------------------------------
export async function run(ctx, args) {
  const layer = checkLayerId(args.layer);
  const radius = args.radius ?? 300;
  if (radius < 20 || radius > 3000) throw new UsageError('--radius must be 20-3000 m');
  const fc = ctx.loadLayer(layer);
  const feats = fc.features.filter((f) => f?.geometry && f.properties?.id != null);
  if (!feats.length) throw new UserError(`layer "${layer}" has no features`);
  const db = await loadDB(ctx);
  ctx.log(`  National DB: ${db.national.rows.length} rows (as of ${db.national.as_of}); Taipei register: ${db.register?.rows.length ?? 0} rows (as of ${db.register?.as_of ?? '—'}).`);
  const results = [], records = [], skippedAll = [];
  const now = new Date().toISOString();
  for (const f of feats) {
    const c = representativePoint(f.geometry);
    const m = matchFeature(db, f.properties, c, { radius });
    // A point add-point placed FROM this listing matches it on name, address and 0 m by construction: the real question
    // (is this listing the user's hotel?) was answered by add-point, so its confidence is the cap here too.
    const pm = f.properties.prov?.observed_by === 'uw add-point' ? f.properties.prov.match : null;
    if (pm?.confidence && m.hotel_id && String(m.hotel_id) === String(f.properties.tw_hotel_id)) {
      m.placed_from = { confidence: pm.confidence, on: pm.on || [] };
      if (confRank(pm.confidence) < confRank(m.confidence)) { m.confidence = pm.confidence; m.status = pm.confidence === 'high' ? 'registered' : 'uncertain'; }
    }
    const lic = licenceObject(m);
    const props = {
      tw_hotel_id: m.hotel_id, tw_register: m.registers.length ? m.registers.join(',') : null, tw_rooms: m.status !== 'not_found' && confRank(m.confidence) >= 2 ? m.rooms : null,
      tw_price_min: confRank(m.confidence) >= 2 ? m.price_min : null, tw_price_max: confRank(m.confidence) >= 2 ? m.price_max : null,
      tw_class: m.class_zh, tw_match: { confidence: m.confidence, by: m.by || [], dist_m: m.dist_m ?? null, candidate: m.candidate || null },
      tw_licence_id: m.licence_id || null, tw_as_of: m.as_of || db.national.as_of, licence: JSON.parse(JSON.stringify(lic)),
    };
    const skipped = ctx.setProps(layer, f.properties.id, props, { prefix: 'tw_' });
    if (skipped.length) skippedAll.push(`${f.properties.id}: ${skipped.join(', ')}`);
    const known = [f.properties.name, f.properties.name_en, f.properties.name_local, ...(Array.isArray(f.properties.aka) ? f.properties.aka : [])].filter(Boolean).map(normName);
    const otherName = m.status !== 'not_found' && m.candidate && !known.some((k) => k && (k === normName(m.candidate)));
    results.push({ id: f.properties.id, name: f.properties.name_en || f.properties.name, ...m, other_name: otherName || undefined });
    if (args.records) records.push(...claimsFor(`${layer}:${f.properties.id}`, m, { observedBy: 'uw-adapter', now }));
  }
  ctx.metrics.merge({
    tw_rooms: { label: 'Registered rooms', short: 'Rooms', unit: 'rooms', format: 'int', better: 'higher', basis: 'registry', confidence: 'high',
      source: 'data.gov.tw 7780 / Taipei register 135464', scale: 'as filed with the authority', as_of: db.register?.as_of || db.national.as_of, display: true },
    tw_price_max: { label: 'Filed max rate', short: 'Max rate', unit: 'NT$', format: 'int', better: 'lower', basis: 'filed', confidence: 'high',
      source: 'data.gov.tw 7780 / Taipei register 135464', note: 'legal ceiling, not a typical price', scale: 'per room per night, as filed',
      as_of: db.register?.as_of || db.national.as_of, display: true },
    tw_price_min: { label: 'Filed min rate', short: 'Min rate', unit: 'NT$', format: 'int', better: 'lower', basis: 'filed', confidence: 'high',
      source: 'data.gov.tw 7780 / Taipei register 135464', note: 'filed floor, not a live price', as_of: db.register?.as_of || db.national.as_of, display: true },
  });
  const wrote = ['data/metrics.json'];
  if (args.records && records.length) { const w = ctx.writeRecords('data/records/tw-hotels.json', records, { attribution: [ATTRIBUTION] }); wrote.push(w.rel, 'data/version.json'); }
  const addedAttr = ctx.addAttribution(ATTRIBUTION);
  if (addedAttr) wrote.push('map.config.json');
  const lines = [`tw-hotels: ${results.length} ${layer} feature(s) checked against data.gov.tw 7780 (${db.national.as_of}) + Taipei register 135464 (${db.register?.as_of ?? 'n/a'}):`];
  for (const r of results) {
    const chip = r.status === 'registered' ? `✓ ${LABEL[r.class || 'hotel']} · ${r.licence_id || '(no id)'}` : r.status === 'uncertain' ? `ⓘ Possibly ${r.licence_id || r.candidate} · match ${r.confidence}` : 'ⓘ Not found in register';
    lines.push(`  ${String(r.id).padEnd(12)} ${chip}${r.status !== 'not_found' ? `  [${r.by.join('+')}${r.dist_m != null ? `, ${r.dist_m} m` : ''}; "${r.candidate}"; ${r.registers.join(', ')}]` : ''}` +
      `${r.price_max != null && confRank(r.confidence) >= 2 ? `  rooms ${r.rooms ?? '—'}, filed NT$${r.price_min ?? '—'}–${r.price_max} (filed rate, not a live price)` : ''}`);
    if (r.placed_from) lines.push(`  ${''.padEnd(12)} placed on the map from this very listing by add-point, so name/address/0 m agree by construction; the match that counts is add-point's (${r.placed_from.confidence}${r.placed_from.on.length ? ` on ${r.placed_from.on.join(', ')}` : ''})${r.placed_from.confidence !== 'high' ? ': tell the user which listing this is' : ''}.`);
    else if (r.other_name) lines.push(`  ${''.padEnd(12)} registered as "${r.candidate}", not "${r.name}" (a branch or company name is common): mention it to the user.`);
  }
  if (skippedAll.length) lines.push(`  kept existing non-prefixed properties: ${skippedAll.join('; ')}`);
  if (addedAttr) lines.push(`  Added the OGDL credit to map.config.json attribution: ${ATTRIBUTION}`);
  const noEn = results.filter((r) => r.status !== 'not_found' && !hasLatin(r.candidate)).length;
  return { summary: lines[0], lines, results: results.map((r) => ({ id: r.id, status: r.status, confidence: r.confidence, placed_from: r.placed_from, other_name: r.other_name, licence_id: r.licence_id, by: r.by, dist_m: r.dist_m, candidate: r.candidate,
    registers: r.registers, rooms: r.rooms, price_min: r.price_min, price_max: r.price_max, as_of: r.as_of })), records: records.length, wrote, no_en_candidates: noEn };
}
