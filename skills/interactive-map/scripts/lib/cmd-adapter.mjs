// `adapter`: pluggable dataset adapters (scripts/adapters/<name>.mjs). ENGINE-SPEC-v0.2 §8.1.
// An adapter exports `meta` ({ name, describe, sources, help, flags }) and `run(ctx, args)`; optionally lookup()/nearby()
// for intent handlers. makeAdapterCtx() is also used by handlers (separate processes) to get the same ctx.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, makeOut, readJSON, writeJSON, writeGeoJSON, exists, parseLngLat, UsageError, UserError } from './util.mjs';
import { adaptersAt } from '../adapters/lib/areas.mjs';
import { fetchJSON, fetchBuffer, overpass, withCap, UA, sharedCacheRoot } from './net.mjs';
import { SCRIPTS_DIR, openSite, loadLayer, layerPath, writeOwnedLayer, addAttribution } from './site.mjs';
import { mergeMetrics } from './metrics.mjs';
import { writeRecords } from './records.mjs';

export const ADAPTERS_DIR = path.join(SCRIPTS_DIR, 'adapters');
export const help = `adapter list [--at lng,lat]   (--at: only the adapters whose area contains that point)
adapter <name> <site> [adapter flags] [--refresh] [--json]
adapter <name> --help
  Runs a dataset adapter from scripts/adapters/. Adapters add prefixed properties (e.g. tw_*) and a generic "licence"
  object to features, write their own layer files, metrics.json entries and (optionally) records, and append the
  dataset's attribution to map.config.json. Large datasets are cached in <adapter>/ of the shared cache (UW_CACHE, else
  INSTAFY_CACHE_DIR, else ~/.cache/uw), refreshed after 24 h or with --refresh, and shared by every site and by uw host
  handlers.`;

/** The cache every site shares (net.mjs sharedCacheRoot: UW_CACHE, else the space's INSTAFY_CACHE_DIR, else ~/.cache/uw):
 *  a dataset downloaded once is kept where the next turn finds it. */
export function uwCacheRoot() { return sharedCacheRoot(); }

export function listAdapters() {
  try { return fs.readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, '')).sort(); } catch { return []; }
}
export async function loadAdapter(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new UsageError(`adapter name "${name}" is not valid`);
  const p = path.join(ADAPTERS_DIR, name + '.mjs');
  if (!exists(p)) throw new UsageError(`no adapter "${name}". Available: ${listAdapters().join(', ') || '(none)'}`);
  const mod = await import(pathToFileURL(p).href);
  if (!mod.meta || typeof mod.run !== 'function') throw new UserError(`adapter ${name} must export meta and run()`);
  return mod;
}

// ctx shared by `uw adapter` and handlers. site may be null for site-less lookups (nearby()).
export function makeAdapterCtx({ site = null, name, log = (l) => console.error(l), refresh = false, observedBy = 'uw-adapter' }) {
  const cacheDir = path.join(uwCacheRoot(), name);
  fs.mkdirSync(cacheDir, { recursive: true });
  const metaPath = path.join(cacheDir, 'meta.json');
  const readMeta = () => { try { return readJSON(metaPath); } catch { return {}; } };
  const pendingProps = new Map(); // layer → fc (edited in memory, written by flush)
  const ctx = {
    site, name, cacheDir, refresh, observedBy, UA,
    fetchJSON, fetchBuffer, overpass, withCap,
    log,
    readMeta,
    writeMeta(key, entry) { const m = readMeta(); m[key] = { ...(m[key] || {}), ...entry }; writeJSON(metaPath, m, { pretty: true }); },
    // A cached file in cacheDir: fresh when younger than maxAgeH (default 24 h) and not refresh.
    cached(file, maxAgeH = 24) {
      const p = path.join(cacheDir, file);
      if (refresh || !exists(p)) return null;
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeH * 3600e3) return null;
      return p;
    },
    cachePath: (file) => path.join(cacheDir, file),
    // data.gov.tw dataset metadata (title, updateDate, distribution URLs), cached 24 h next to the data.
    async dataGovTw(id) {
      const file = `datagovtw-${id}.json`;
      const hit = ctx.cached(file);
      if (hit) { try { return readJSON(hit); } catch {} }
      try {
        const d = await fetchJSON(`https://data.gov.tw/api/v2/rest/dataset/${id}`, { label: `data.gov.tw dataset ${id}`, cache: false, timeoutMs: 30000, retries: 2 });
        const r = d.result || d;
        const out = { id, title: r.title, updated: (r.updateDate || r.modifiedDate || '').slice(0, 10) || null, page: `https://data.gov.tw/dataset/${id}`,
          distribution: (r.distribution || []).map((x) => ({ format: x.resourceFormat, url: x.resourceDownloadUrl, description: x.resourceDescription })) };
        writeJSON(path.join(cacheDir, file), out, { pretty: true });
        return out;
      } catch (e) {
        log(`  (data.gov.tw metadata for ${id} unavailable: ${e.message}; using the known download URL)`);
        const stale = path.join(cacheDir, file);
        if (exists(stale)) { try { return readJSON(stale); } catch {} }
        return null;
      }
    },
    loadLayer: (id, opts) => { if (!site) throw new UserError('no site'); return pendingProps.get(id) || loadLayer(site, id, opts); },
    writeOwnedLayer: (id, fc, opts = {}) => writeOwnedLayer(site, id, fc, { cmd: name, ...opts }),
    // Set adapter-owned properties on a feature: keys with the adapter's prefix (e.g. "tw_") and "licence" always;
    // any other key only when the feature does not have it yet (adapters never overwrite non-prefixed properties).
    setProps(layer, id, props, { prefix = 'tw_', clearPrefix = true } = {}) {
      let fc = pendingProps.get(layer);
      if (!fc) { fc = loadLayer(site, layer); pendingProps.set(layer, fc); }
      const f = fc.features.find((x) => String(x?.properties?.id) === String(id));
      if (!f) throw new UserError(`no feature ${layer}:${id}`);
      if (clearPrefix) for (const k of Object.keys(f.properties)) if (k.startsWith(prefix) && !(k in props)) delete f.properties[k];
      const skipped = [];
      for (const [k, v] of Object.entries(props)) {
        const owned = k.startsWith(prefix) || k === 'licence';
        if (!owned && f.properties[k] !== undefined && JSON.stringify(f.properties[k]) !== JSON.stringify(v)) { skipped.push(k); continue; }
        if (v === undefined || v === null) delete f.properties[k]; else f.properties[k] = v;
      }
      return skipped;
    },
    flush() {
      const wrote = [];
      for (const [layer, fc] of pendingProps) { writeGeoJSON(layerPath(site, layer), fc); wrote.push(path.relative(site.dir, layerPath(site, layer)).split(path.sep).join('/')); }
      pendingProps.clear();
      return wrote;
    },
    writeRecords: (rel, records, { attribution = [] } = {}) => writeRecords(site.dir, rel, records, { cmd: 'adapter', attribution }),
    metrics: { merge: (entries) => mergeMetrics(site.dir, entries, name) },
    // Append an attribution line to map.config.json when absent. Returns true when added.
    addAttribution: (text) => addAttribution(site, text),
  };
  return ctx;
}

// Decode text that may be UTF-8 (with or without BOM) or Big5 (data.taipei CSVs are Big5).
export function decodeTaiwanText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; } catch {}
  return { text: new TextDecoder('big5').decode(buf), encoding: 'big5' };
}
// RFC 4180-ish CSV → array of objects keyed by the header row.
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.replace(/^﻿/, '').trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export async function run(argv) {
  const [first, ...rest] = argv;
  if (!first || first === 'list' || first === '--help' || first === '-h') {
    if (first === '--help' || first === '-h') { console.log(help); return 0; }
    const json = rest.includes('--json') || argv.includes('--json');
    // --at lng,lat: only the adapters whose area contains that point, with what they give the generic commands
    const atIdx = rest.indexOf('--at');
    const at = atIdx >= 0 ? parseLngLat(rest[atIdx + 1] || '', 'at') : null;
    const areas = at ? new Map(adaptersAt(at).map((a) => [a.name, a])) : null;
    const items = [];
    for (const n of listAdapters()) {
      if (areas && !areas.has(n)) continue;
      try { const m = await loadAdapter(n); items.push({ name: n, describe: m.meta.describe, sources: m.meta.sources || [], flags: m.meta.flags || {}, ...(areas ? { provides: areas.get(n).provides } : {}) }); }
      catch (e) { items.push({ name: n, error: e.message }); }
    }
    if (areas && !items.length) {
      if (json) process.stdout.write(JSON.stringify({ ok: true, at, adapters: [] }, null, 2) + '\n');
      else console.log(`No dataset adapter covers ${at.join(',')}: the commands use OpenStreetMap there.`);
      return 0;
    }
    if (json) process.stdout.write(JSON.stringify({ ok: true, adapters: items }, null, 2) + '\n');
    else {
      console.log('Adapters (scripts/adapters/):');
      for (const a of items) console.log(`  ${a.name.padEnd(18)} ${a.error ? 'ERROR ' + a.error : a.describe}${a.provides ? ` [gives: ${a.provides.join(', ')}]` : ''}${a.sources?.length ? `\n  ${''.padEnd(18)} sources: ${a.sources.map((s) => `${s.id} (${s.licence})`).join(', ')}` : ''}`);
      console.log('Run: uw adapter <name> --help');
    }
    return 0;
  }
  const mod = await loadAdapter(first);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(mod.meta.help || mod.meta.describe); return 0; }
  const args = parseArgs(rest, { refresh: 'bool', ...(mod.meta.flags || {}) }, { positionals: [1, 1], command: `adapter ${first}` });
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const ctx = makeAdapterCtx({ site, name: first, refresh: !!args.refresh, log: (l) => { if (!out.json) console.error(l); } });
  const t0 = Date.now();
  const res = await mod.run(ctx, args, out);
  const wrote = [...new Set([...(res.wrote || []), ...ctx.flush()])];
  out.result({ ok: true, adapter: first, ...res, wrote, ms: Date.now() - t0 }, [...(res.lines || [res.summary]), wrote.length ? `Wrote: ${wrote.join(', ')}` : null]);
  return res.exitCode ?? 0;
}
