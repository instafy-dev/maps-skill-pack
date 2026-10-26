// map-pack engine: records (uw.records@1) — claims, offers and items with provenance (ENGINE-SPEC-v0.2 §9.6, §9.7).
// Kit-owned file: sites should not edit it.
// Records are UNTRUSTED data (they come from agents, adapters and hosts). This module validates every record against
// the records schema, keeps only finite numbers and https (or localhost http) URLs, and merges them with the same rules
// as scripts/lib/records.mjs. Rendering code must use textContent for every string that came from here.
import { validate, fmtErrors } from './schema.js';
import { normBasis } from './util.js';

export const MAX_RECORDS = 2000;
export const MAX_BYTES = 200 * 1024;

// The records schema (schemas/records.schema.json), embedded so the page needs no extra request.
const RID = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,96}$' };
const REF = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[^\\s]{1,120}$' };
const HTTPS = { type: 'string', maxLength: 2000, pattern: '^https://|^http://(localhost|127\\.0\\.0\\.1)(:|/)' };
export const RECORDS_SCHEMA = {
  type: 'object', required: ['schema', 'records'],
  properties: {
    schema: { const: 'uw.records@1' }, uw: { type: 'object' },
    attribution: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 10 },
    records: { type: 'array', maxItems: MAX_RECORDS, items: { oneOf: [{ $ref: '#/$defs/claim' }, { $ref: '#/$defs/offer' }, { $ref: '#/$defs/item' }] } },
  },
  $defs: {
    rid: RID, ref: REF,
    basis: { enum: ['measured', 'routed', 'counted', 'estimated', 'registry', 'filed', 'live', 'brand', 'user_note', 'editorial', 'modelled', 'inferred'] },
    confidence: { enum: ['high', 'medium', 'low'] },
    text: { type: 'string', maxLength: 140 },
    https: HTTPS,
    prov: {
      type: 'object', required: ['source', 'lane', 'observed_at', 'ttl_s'], additionalProperties: false,
      properties: {
        source: { type: 'string', maxLength: 80 }, source_label: { type: 'string', maxLength: 80 },
        lane: { enum: ['link', 'official', 'open', 'capture', 'feed', 'assist', 'local'] },
        url: { $ref: '#/$defs/https' }, observed_at: { type: 'string', format: 'date-time' },
        observed_by: { type: 'string', maxLength: 80 }, observer: { type: 'string', maxLength: 80 },
        as_of: { type: 'string', maxLength: 32 }, ttl_s: { type: 'integer', minimum: 0 }, ttl: { type: 'integer', minimum: 0 },
        class: { enum: ['stored', 'live'] },
        license: { type: 'object', additionalProperties: false, properties: {
          store: { enum: ['none', 'ids', 'ttl', 'full'] }, attribution: { type: 'string', maxLength: 300 }, url: { $ref: '#/$defs/https' } } },
        adapter: { type: 'string', maxLength: 60 }, job: { type: 'string', maxLength: 80 },
        intent: { type: 'object', required: ['name'], properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,47}$' }, params: { type: 'object' }, id: { type: 'string', maxLength: 40 } } },
        snapshot_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, sandbox: { type: 'boolean' }, logged_in: { const: false },
        refresh_days: { type: 'number', minimum: 1, maximum: 3650 }, tier: { type: 'string', maxLength: 20 }, requested_by: { type: 'string', maxLength: 80 },
        task: { type: 'string', maxLength: 80 }, rid: { type: 'string', maxLength: 120 },
      },
    },
    claim: {
      type: 'object', required: ['type', 'cid', 'ref', 'attr', 'basis', 'prov'], additionalProperties: false,
      properties: {
        type: { const: 'claim' }, cid: { $ref: '#/$defs/rid' }, ref: { $ref: '#/$defs/ref' },
        attr: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,47}$' },
        value: { type: ['string', 'number', 'boolean', 'null'], maxLength: 140 },
        unit: { type: 'string', maxLength: 12 }, label: { type: 'string', maxLength: 60 }, note: { $ref: '#/$defs/text' },
        status: { enum: ['ok', 'not_found', 'uncertain', 'error'] },
        basis: { $ref: '#/$defs/basis' }, confidence: { $ref: '#/$defs/confidence' },
        match: { type: 'object', additionalProperties: false, properties: {
          confidence: { $ref: '#/$defs/confidence' }, by: { type: 'array', items: { enum: ['id', 'phone', 'address', 'name', 'geo'] }, maxItems: 5 },
          dist_m: { type: 'number', minimum: 0 }, candidate: { type: 'string', maxLength: 120 } } },
        prov: { $ref: '#/$defs/prov' },
      },
    },
    offer: {
      type: 'object', required: ['type', 'oid', 'ref', 'price', 'prov'], additionalProperties: false,
      properties: {
        type: { const: 'offer' }, oid: { $ref: '#/$defs/rid' }, ref: { $ref: '#/$defs/ref' }, vid: { $ref: '#/$defs/rid' },
        variant: { type: 'object', additionalProperties: false, properties: {
          checkin: { type: 'string', format: 'date' }, checkout: { type: 'string', format: 'date' },
          guests: { type: 'integer', minimum: 1, maximum: 30 }, rooms: { type: 'integer', minimum: 1, maximum: 10 }, label: { type: 'string', maxLength: 80 } } },
        seller: { type: 'object', required: ['name'], additionalProperties: false, properties: {
          name: { type: 'string', maxLength: 80 }, trust: { enum: ['curated', 'unknown'] } } },
        price: { type: 'object', required: ['amount', 'currency'], additionalProperties: false, properties: {
          amount: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          kind: { enum: ['total', 'nightly', 'from', 'regular', 'sale', 'member'] }, taxes_included: { enum: ['yes', 'no', 'unknown'] } } },
        refundable: { type: ['boolean', 'null'] }, availability: { enum: ['in_stock', 'out', 'unknown'] },
        handoff: { type: 'object', required: ['url'], additionalProperties: false, properties: {
          url: { $ref: '#/$defs/https' }, label: { type: 'string', maxLength: 40 }, affiliate: { type: 'boolean' } } },
        label: { type: 'string', maxLength: 80 }, basis: { $ref: '#/$defs/basis' }, prov: { $ref: '#/$defs/prov' },
        expires_at: { type: 'string', format: 'date-time' }, free_until: { type: 'string', format: 'date-time' },
        display: { type: 'object', additionalProperties: false, properties: { photos: { type: 'boolean' }, reviews: { type: 'boolean' }, ai_summary: { type: 'boolean' } } },
      },
    },
    item: {
      type: 'object', required: ['type', 'iid', 'kind', 'name', 'geo', 'prov'], additionalProperties: false,
      properties: {
        type: { const: 'item' }, iid: { $ref: '#/$defs/rid' },
        layer: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$' }, kind: { type: 'string', maxLength: 40 },
        name: { type: 'object', additionalProperties: false, properties: { local: { type: 'string', maxLength: 120 }, en: { type: 'string', maxLength: 120 } } },
        geo: { type: 'object', required: ['lng', 'lat'], additionalProperties: false, properties: {
          lng: { type: 'number', minimum: -180, maximum: 180 }, lat: { type: 'number', minimum: -90, maximum: 90 } } },
        keys: { type: 'object', additionalProperties: { type: 'string', maxLength: 120 } },
        props: { type: 'object', maxProperties: 30, additionalProperties: { type: ['string', 'number', 'boolean', 'null'], maxLength: 140 } },
        prov: { $ref: '#/$defs/prov' },
      },
    },
  },
};

export const recKey = (r) => (r.type === 'claim' ? 'c:' + r.cid : r.type === 'offer' ? 'o:' + r.oid : 'i:' + r.iid);
export const recRef = (r) => (r.type === 'item' ? null : r.ref);
const obsT = (r) => { const t = Date.parse(r?.prov?.observed_at); return isFinite(t) ? t : 0; };
/** A live price or availability past its TTL (or expires_at). Stored official data never "expires" on a TTL: it
 *  goes stale against its own date and update cadence instead (see stale()). */
export function expired(r, now = Date.now()) {
  if (!r?.prov) return false;
  if (r.type === 'offer' && r.expires_at) { const t = Date.parse(r.expires_at); if (isFinite(t)) return now > t; }
  if (r.prov.class === 'stored' && r.type !== 'offer') return false;
  const ttl = r.prov.ttl_s;
  if (typeof ttl !== 'number' || ttl <= 0) return false;
  return now > obsT(r) + ttl * 1000;
}
/** Stored data older than its source's update cadence (prov.refresh_days, default 45): "may be out of date". */
export function stale(r, now = Date.now()) {
  if (!r?.prov || r.prov.class !== 'stored') return false;
  const t = Date.parse(r.prov.as_of || r.prov.observed_at);
  if (!isFinite(t)) return false;
  return now - t > (Number(r.prov.refresh_days) || 45) * 86400e3;
}
const deepCopy = (x) => JSON.parse(JSON.stringify(x));

/** Normalise aliases (observer → observed_by, ttl → ttl_s), then validate. Returns { rec } or { error }. */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object' };
  let r;
  try { r = deepCopy(raw); } catch { return { error: 'not JSON' }; }
  if (r.prov && typeof r.prov === 'object') {
    if (r.prov.observer != null && r.prov.observed_by == null) r.prov.observed_by = r.prov.observer;
    if (r.prov.ttl != null && r.prov.ttl_s == null) r.prov.ttl_s = r.prov.ttl;
    delete r.prov.observer; delete r.prov.ttl;
  }
  const def = RECORDS_SCHEMA.$defs[r.type];
  if (!def) return { error: `unknown record type "${r.type}"` };
  const errs = validate(def, r, { root: RECORDS_SCHEMA, max: 5 });
  if (errs.length) return { error: fmtErrors(errs, 2) };
  if (r.basis) r.basis = normBasis(r.basis) || r.basis;
  return { rec: r };
}

export class RecordStore {
  constructor() {
    this.byKey = new Map();      // key → record
    this.attribution = new Set();
    this.rejected = 0;
  }
  /** Merge a records file. Returns { ok, error?, changed: [records], refs: Set, items: [records] }. */
  ingestFile(json, text) {
    if (!json || typeof json !== 'object' || json.schema !== 'uw.records@1' || !Array.isArray(json.records)) return { ok: false, error: 'not a uw.records@1 file' };
    for (const a of Array.isArray(json.attribution) ? json.attribution.slice(0, 10) : []) if (typeof a === 'string' && a.length <= 300) this.attribution.add(a);
    let list = json.records;
    let partial = null;
    // a file over the budget is read partially (the newest records that fit), never dropped as a whole: one busy
    // search must not blank the map for every viewer. Items keep their claims (claims whose item fell out go too).
    if ((typeof text === 'string' && text.length > MAX_BYTES) || list.length > MAX_RECORDS) {
      const sorted = [...list].filter((r) => r && typeof r === 'object').sort((a, b) => obsT(b) - obsT(a));
      const kept = []; let bytes = 0;
      for (const r of sorted) { let n = 0; try { n = JSON.stringify(r).length + 1; } catch { continue; } if (bytes + n > MAX_BYTES - 2048 || kept.length >= MAX_RECORDS) break; bytes += n; kept.push(r); }
      const items = new Set(kept.filter((r) => r.type === 'item').map((r) => `${r.layer || ''}:${r.iid}`));
      const allItems = new Set(list.filter((r) => r?.type === 'item').map((r) => `${r.layer || ''}:${r.iid}`));
      list = kept.filter((r) => r.type === 'item' || !allItems.has(r.ref) || items.has(r.ref));
      partial = { kept: list.length, total: json.records.length };
    }
    return { ok: true, partial, ...this.ingest(list) };
  }
  /** drop one record by key or by its broker rid (record.expire) */
  remove(keyOrRid) {
    if (this.byKey.delete(keyOrRid)) return true;
    for (const [k, r] of this.byKey) if (r.prov?.rid === keyOrRid || r.oid === keyOrRid || r.cid === keyOrRid) { this.byKey.delete(k); return true; }
    return false;
  }
  /** Merge records (from a file, SSE or postMessage). Same key: newer observed_at wins. Claims with the same
   *  (ref, attr, prov.source) under another key: the newer replaces the older. */
  ingest(list) {
    const changed = [], refs = new Set(), items = [];
    for (const raw of Array.isArray(list) ? list.slice(0, MAX_RECORDS) : []) {
      const { rec, error } = sanitize(raw);
      if (!rec) { this.rejected++; console.warn('[map] record ignored:', error); continue; }
      const k = recKey(rec), old = this.byKey.get(k);
      if (old && obsT(old) > obsT(rec)) continue;
      if (old && JSON.stringify(old) === JSON.stringify(rec)) continue;
      if (rec.type === 'claim') {
        for (const [ok, o] of this.byKey) {
          if (ok === k || o.type !== 'claim' || o.ref !== rec.ref || o.attr !== rec.attr || o.prov.source !== rec.prov.source) continue;
          if (obsT(o) > obsT(rec)) { rec._superseded = true; break; }
          this.byKey.delete(ok);
        }
        if (rec._superseded) continue;
      }
      this.byKey.set(k, rec);
      changed.push(rec);
      if (rec.type === 'item') items.push(rec); else refs.add(rec.ref);
    }
    return { changed, refs, items };
  }
  all() { return [...this.byKey.values()]; }
  forRef(ref) { return this.all().filter((r) => r.ref === ref); }
  claims(ref) { return this.forRef(ref).filter((r) => r.type === 'claim').sort((a, b) => obsT(b) - obsT(a)); }
  /** newest claim of an attribute for an item (any source) */
  claim(ref, attr) { return this.claims(ref).find((c) => c.attr === attr) || null; }
  /** the newest claim of an attribute from each source (for "sources disagree") */
  claimsBySource(ref, attr) {
    const by = new Map();
    for (const c of this.claims(ref)) if (c.attr === attr && !by.has(c.prov.source)) by.set(c.prov.source, c);
    return [...by.values()];
  }
  offers(ref) { return this.forRef(ref).filter((r) => r.type === 'offer'); }
  items(layer) { return this.all().filter((r) => r.type === 'item' && (!layer || r.layer === layer)); }
  /** Cheapest comparable offer ("compare like with like"): same currency, price kind, variant
   *  and refundability, curated sellers only, and taxes known. An offer whose taxes are unknown is never "best". */
  bestOffer(ref, now = Date.now()) {
    const os = this.offers(ref).filter((o) => o.seller?.trust !== 'unknown' && !expired(o, now) && o.availability !== 'out' && (o.price.taxes_included === 'yes' || o.price.taxes_included === 'no'));
    if (!os.length) return null;
    const groups = new Map();
    for (const o of os) (groups.get(offerGroup(o)) || groups.set(offerGroup(o), []).get(offerGroup(o))).push(o);
    // the biggest comparable group (taxes included preferred) decides the headline price
    const best = [...groups.values()].sort((a, b) => (b[0].price.taxes_included === 'yes') - (a[0].price.taxes_included === 'yes') || b.length - a.length)[0];
    return best.sort((a, b) => a.price.amount - b.price.amount)[0];
  }
  /** lowest live offer when none is comparable ("from NT$3,420 · taxes unclear"): shown, never called best */
  lowestOffer(ref, now = Date.now()) {
    const os = this.offers(ref).filter((o) => !expired(o, now) && o.availability !== 'out');
    return os.sort((a, b) => a.price.amount - b.price.amount)[0] || null;
  }
}
export const offerGroup = (o) => [o.price.currency, o.price.taxes_included || 'unknown', JSON.stringify(o.variant || {}), o.price.kind || 'total', o.refundable === true ? 'r' : o.refundable === false ? 'n' : '?'].join('|');

/** Instafy bind v1 `record.upsert` payloads → uw.records@1 records (Instafy docs/Bound-Sites.md §2). travel.offer@1 becomes an
 *  offer on <layer>:<pid>; a payload that already is a uw record passes through. Returns null when it can't map. */
export function fromBindRecord(p, { layer } = {}) {
  if (!p || typeof p !== 'object') return null;
  if (p.type === 'claim' || p.type === 'offer' || p.type === 'item') return p;
  if (p.record && typeof p.record === 'object' && ['claim', 'offer', 'item'].includes(p.record.type)) return p.record;
  const d = p.data && typeof p.data === 'object' ? p.data : null, pv = p.provenance && typeof p.provenance === 'object' ? p.provenance : {};
  if (p.schema !== 'travel.offer@1' || !d || !layer || d.pid == null || typeof d.price !== 'number') return null;
  let host = 'agent';
  try { host = new URL(pv.origin || pv.url || d.url).hostname.replace(/^www\./, ''); } catch { /* */ }
  const lane = String(pv.lane || '');
  const at = typeof pv.capturedAt === 'string' ? pv.capturedAt : new Date().toISOString();
  const variant = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.checkin || '')) variant.checkin = d.checkin;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.checkout || '')) variant.checkout = d.checkout;
  if (Number.isInteger(d.guests)) variant.guests = d.guests;
  if (typeof d.room === 'string') variant.label = d.room.slice(0, 80);
  const tx = d.taxes_included === 'yes' || d.taxes_included === true ? 'yes' : d.taxes_included === 'no' || d.taxes_included === false ? 'no' : 'unknown';
  const rid = String(p.rid || `${host}:${d.pid}:${d.checkin || ''}:${d.room || ''}`);
  return {
    type: 'offer', oid: rid.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 96), ref: `${layer}:${d.pid}`,
    price: { amount: d.price, currency: String(d.currency || 'USD').toUpperCase().slice(0, 3), kind: d.per === 'night' ? 'nightly' : 'total', taxes_included: tx },
    ...(Object.keys(variant).length ? { variant } : {}), seller: { name: host.slice(0, 80), trust: 'curated' },
    ...(typeof d.refundable === 'boolean' ? { refundable: d.refundable } : {}),
    ...(typeof d.url === 'string' ? { handoff: { url: d.url } } : {}),
    ...(typeof d.expires_at === 'string' ? { expires_at: d.expires_at } : {}), ...(typeof d.free_until === 'string' ? { free_until: d.free_until } : {}),
    basis: 'live',
    prov: { source: host.slice(0, 80), lane: /^recipe/.test(lane) ? 'capture' : lane === 'agent' ? 'assist' : 'capture', observed_at: at, ttl_s: 3600, class: 'live',
      ...(typeof pv.url === 'string' ? { url: pv.url } : {}), ...(p.taskId ? { task: String(p.taskId).slice(0, 80) } : {}), rid: rid.slice(0, 120),
      ...(lane ? { tier: lane.slice(0, 20) } : {}) },
  };
}

/** item record → GeoJSON feature (support tier in its layer). */
export function itemFeature(r) {
  const name = r.name?.local || r.name?.en || r.iid;
  const props = { ...(r.keys || {}), ...(r.props || {}) };
  for (const k of Object.keys(props)) if (k.startsWith('_') || k === 'id') delete props[k];
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [r.geo.lng, r.geo.lat] },
    properties: { ...props, id: r.iid, name, ...(r.name?.en && r.name.en !== name ? { name_en: r.name.en } : {}), kind: r.kind,
      source: r.prov?.source_label || r.prov?.source || '', _found: { intent: r.prov?.intent?.name || null, source: r.prov?.source_label || r.prov?.source || '', at: r.prov?.observed_at || null } } };
}
