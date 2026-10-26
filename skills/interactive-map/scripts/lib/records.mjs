// Records (uw.records@1, ENGINE-SPEC-v0.2 §9.6): schema check, normalise, merge, write + data/version.json bump.
// Shared by uw host (the apply step), validate and the adapters. The engine's records.js follows the same merge rules.
import fs from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, exists, UserError } from './util.mjs';
import { noteSiteWrite } from './save-owner.mjs';
import { validate } from './schema-lite.mjs';
import { SCRIPTS_DIR } from './site.mjs';

let SCHEMA = null;
export function recordsSchema() {
  if (!SCHEMA) SCHEMA = readJSON(path.join(SCRIPTS_DIR, 'schemas', 'records.schema.json'));
  return SCHEMA;
}
export const RECORDS_PATH_RE = /^data\/records\/[A-Za-z0-9_.-]{1,80}\.json$/;
export const MAX_RECORDS = 2000, MAX_FILE_BYTES = 200 * 1024;

// Canonical names: observer → observed_by, ttl → ttl_s. Returns a copy.
export function normalizeRecord(r) {
  if (!r || typeof r !== 'object') return r;
  const out = JSON.parse(JSON.stringify(r));
  const p = out.prov;
  if (p && typeof p === 'object') {
    if (p.observer !== undefined && p.observed_by === undefined) p.observed_by = p.observer;
    delete p.observer;
    if (p.ttl !== undefined && p.ttl_s === undefined) p.ttl_s = p.ttl;
    delete p.ttl;
  }
  return out;
}

export function validateRecord(r) {
  const s = recordsSchema();
  const def = s.$defs[r?.type];
  if (!def || !['claim', 'offer', 'item'].includes(r?.type)) return [{ path: '$.type', message: 'type must be "claim", "offer" or "item"' }];
  return validate(def, r, { root: s, max: 8 });
}
export function validateRecordsFile(obj) {
  return validate(recordsSchema(), obj, { max: 30 });
}

export function recordKey(r) {
  if (r.type === 'claim') return 'c:' + r.cid;
  if (r.type === 'offer') return 'o:' + r.oid;
  return 'i:' + r.iid;
}
const ts = (r) => Date.parse(r?.prov?.observed_at || '') || 0;

// Merge incoming into existing. Same key: newer observed_at wins. Claims with the same (ref, attr, prov.source) but a
// different cid: the newer replaces the older (the older is dropped from the file).
export function mergeRecords(existing, incoming) {
  const byKey = new Map();
  for (const r of existing) byKey.set(recordKey(r), r);
  let added = 0, replaced = 0, kept = 0, dropped = 0;
  for (const r of incoming) {
    const k = recordKey(r);
    const prev = byKey.get(k);
    if (prev) { if (ts(r) >= ts(prev)) { byKey.set(k, r); replaced++; } else kept++; continue; }
    if (r.type === 'claim') {
      let older = null;
      for (const [k2, x] of byKey) if (x.type === 'claim' && x.ref === r.ref && x.attr === r.attr && x.prov?.source === r.prov?.source) { older = [k2, x]; break; }
      if (older) {
        if (ts(r) >= ts(older[1])) { byKey.delete(older[0]); byKey.set(k, r); replaced++; dropped++; } else kept++;
        continue;
      }
    }
    byKey.set(k, r); added++;
  }
  return { records: [...byKey.values()], added, replaced, kept, dropped };
}

export function readRecordsFile(abs) {
  if (!exists(abs)) return { schema: 'uw.records@1', uw: {}, attribution: [], records: [] };
  const obj = readJSON(abs);
  if (obj?.schema !== 'uw.records@1' || !Array.isArray(obj.records)) throw new UserError(`${abs} is not a uw.records@1 file`);
  return obj;
}

// Write (merge) records into a site file and bump data/version.json. rel must be data/records/<name>.json.
/** Keep a records list under a byte budget by dropping the oldest groups first. A group is an item with every claim
 *  and offer about it (ref "<layer>:<iid>"), or all records about one other ref: a place never loses half its facts. */
export function trimRecords(records, budget) {
  const size = (r) => Buffer.byteLength(JSON.stringify(r)) + 1;
  let total = records.reduce((s, r) => s + size(r), 0) + 200;
  if (total <= budget) return { records, evicted: 0 };
  const groups = new Map();
  for (const r of records) {
    const k = r.type === 'item' ? `${r.layer || ''}:${r.iid}` : r.ref;
    const g = groups.get(k) || { k, recs: [], t: 0, bytes: 0 };
    g.recs.push(r); g.t = Math.max(g.t, ts(r)); g.bytes += size(r);
    groups.set(k, g);
  }
  const order = [...groups.values()].sort((a, b) => a.t - b.t);
  const drop = new Set();
  let evicted = 0;
  for (const g of order) { if (total <= budget) break; drop.add(g.k); total -= g.bytes; evicted += g.recs.length; }
  return { records: records.filter((r) => !drop.has(r.type === 'item' ? `${r.layer || ''}:${r.iid}` : r.ref)), evicted };
}

export function writeRecords(siteDir, rel, incoming, { cmd = 'host', attribution = [], jobs, budget = MAX_FILE_BYTES - 20 * 1024 } = {}) {
  if (!RECORDS_PATH_RE.test(rel)) throw new UserError(`records path "${rel}" must look like data/records/<name>.json`);
  const abs = path.join(siteDir, rel);
  const cur = readRecordsFile(abs);
  const norm = incoming.map(normalizeRecord);
  const res = mergeRecords(cur.records, norm);
  if (res.records.length > MAX_RECORDS) res.records = res.records.sort((a, b) => ts(b) - ts(a)).slice(0, MAX_RECORDS);
  // the file never outgrows what a viewer will read (the engine reads ≤ 200 KB): oldest results go first
  const trimmed = trimRecords(res.records, budget);
  res.records = trimmed.records;
  const attr = [...new Set([...(cur.attribution || []), ...attribution.filter(Boolean)])].slice(0, 10);
  const out = { schema: 'uw.records@1', uw: { cmd, updated_at: new Date().toISOString() }, attribution: attr, records: res.records };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const bytes = writeJSON(abs, out);
  // a running `uw host` owns this write and commits it in a space's checkout (save-owner.mjs)
  noteSiteWrite(abs, () => fs.readFileSync(abs));
  const ver = bumpVersion(siteDir, { files: [rel], jobs });
  return { rel, bytes, total: res.records.length, added: res.added, replaced: res.replaced, dropped: res.dropped, v: ver.files[rel], version: ver.v,
    oversize: bytes > MAX_FILE_BYTES, evicted: trimmed.evicted };
}

export function versionPath(siteDir) { return path.join(siteDir, 'data', 'version.json'); }
export function readVersion(siteDir) {
  try { const v = readJSON(versionPath(siteDir)); if (v && typeof v.v === 'number') return { files: {}, jobs: {}, ...v }; } catch {}
  return { v: 0, updated_at: null, files: {}, jobs: {} };
}
// Bump the site's version: v+1, and files[rel] = new v for each touched file; jobs merged (last 200 kept).
export function bumpVersion(siteDir, { files = [], jobs } = {}) {
  const ver = readVersion(siteDir);
  ver.v = (ver.v || 0) + 1;
  ver.updated_at = new Date().toISOString();
  for (const f of files) ver.files[f] = ver.v;
  if (jobs) {
    ver.jobs = { ...ver.jobs, ...jobs };
    const keys = Object.keys(ver.jobs);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete ver.jobs[k];
  }
  writeJSON(versionPath(siteDir), ver, { pretty: true });
  noteSiteWrite(versionPath(siteDir), () => fs.readFileSync(versionPath(siteDir)));
  return ver;
}

// `uw reload`: stamp data/version.json "reload" (a new id) and "reload_note", without touching v, files or jobs.
// A running `uw host` watches the file and pushes { command: { name: "reload" } } to every viewer over __uw/events;
// viewers that only poll compare "reload" with what they loaded (bind.js pollNow) and reload in place too.
export function stampReload(siteDir, note = null) {
  const ver = readVersion(siteDir);
  ver.reload = new Date().toISOString() + '~' + Math.random().toString(36).slice(2, 6);
  if (note) ver.reload_note = note; else delete ver.reload_note;
  writeJSON(versionPath(siteDir), ver, { pretty: true });
  return ver;
}

// Stable ids: "clm_<slug>", limited to the rid pattern.
export function rid(prefix, ...parts) {
  const s = parts.map((p) => String(p ?? '').normalize('NFKD').replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '')).filter(Boolean).join('_');
  return (prefix + '_' + s).slice(0, 96);
}
