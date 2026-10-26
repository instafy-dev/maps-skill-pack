// Site helpers: locating a site, its config and layer files, resolving refs, writing owned layer files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, writeGeoJSON, exists, UserError, UsageError, parseLngLat, fmtBytes, representativePoint, geomBBox, round6 } from './util.mjs';
import { setCacheDir } from './net.mjs';
import { withSiteLock } from './site-lock.mjs';

export { withSiteLock };

export const SCRIPTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = path.dirname(SCRIPTS_DIR);
export const STARTER_DIR = path.join(SKILL_DIR, 'starter');

export const LAYER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

// Open an existing site directory. Sets the response cache to <dir>/.uwcache.
export function openSite(dir, { requireConfig = true } = {}) {
  if (!dir) throw new UsageError('missing site directory (first argument)');
  const abs = path.resolve(dir);
  if (!exists(abs) || !fs.statSync(abs).isDirectory())
    throw new UserError(`site directory "${dir}" does not exist. Create one with: uw new ${dir}`);
  const cfgPath = path.join(abs, 'map.config.json');
  let config = null;
  if (exists(cfgPath)) {
    try { config = readJSON(cfgPath); } catch (e) {
      throw new UserError(`map.config.json in "${dir}" is not valid JSON (${e.message}). Fix it, then run: uw validate ${dir}`);
    }
  } else if (requireConfig) {
    throw new UserError(`"${dir}" has no map.config.json, so it is not a map site. Create one with: uw new ${dir}`);
  }
  const site = { dir: abs, rel: dir, cfgPath, config };
  setCacheDir(path.join(abs, '.uwcache'));
  ensureGitignore(abs, ['.uwcache/']);
  return site;
}

export function ensureGitignore(dir, entries) {
  const f = path.join(dir, '.gitignore');
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch {}
  const lines = new Set(txt.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !lines.has(e) && !lines.has(e.replace(/\/$/, '')) && !lines.has(e + '*'));
  if (!missing.length) return;
  const sep = txt && !txt.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(f, txt + sep + missing.join('\n') + '\n');
}

export function checkLayerId(id) {
  if (!id) throw new UsageError('missing required flag --layer <id>');
  if (!LAYER_ID_RE.test(id))
    throw new UsageError(`--layer "${id}" is not a valid layer id. Use letters, digits, "-" or "_" (e.g. hotels, day1, mrt-lines)`);
  return id;
}

export function configLayer(site, id) {
  return (site.config?.layers || []).find((l) => l && l.id === id) || null;
}

// File path for a layer: config's data path when it is a local file, else data/<id>.geojson.
export function layerPath(site, id) {
  const l = configLayer(site, id);
  if (l && typeof l.data === 'string' && !/^https?:\/\//i.test(l.data)) {
    const p = path.resolve(site.dir, l.data);
    if (!p.startsWith(site.dir + path.sep)) throw new UserError(`layer "${id}" data path "${l.data}" points outside the site`);
    return p;
  }
  return path.join(site.dir, 'data', `${id}.geojson`);
}
export function layerRelPath(site, id) { return path.relative(site.dir, layerPath(site, id)).split(path.sep).join('/'); }

export function loadLayer(site, id, { required = true } = {}) {
  const p = layerPath(site, id);
  if (!exists(p)) {
    if (!required) return null;
    const known = listLayerIds(site);
    throw new UserError(`layer "${id}" has no data file (${path.relative(site.dir, p)}).` +
      (known.length ? ` Known layers: ${known.join(', ')}.` : ' The site has no layer data yet.'));
  }
  let fc;
  try { fc = readJSON(p); } catch (e) { throw new UserError(`${path.relative(site.dir, p)} is not valid JSON: ${e.message}`); }
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features))
    throw new UserError(`${path.relative(site.dir, p)} is not a GeoJSON FeatureCollection`);
  return fc;
}

export function listLayerIds(site) {
  const ids = new Set((site.config?.layers || []).map((l) => l?.id).filter(Boolean));
  const dd = path.join(site.dir, 'data');
  try { for (const f of fs.readdirSync(dd)) if (f.endsWith('.geojson')) ids.add(f.replace(/\.geojson$/, '')); } catch {}
  return [...ids];
}

// Resolve "<layer>:<id>" or "lng,lat" to { coord, id, name, layer, feature }.
export function resolvePoint(site, s, flag = 'point') {
  s = String(s).trim();
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(s)) {
    const c = parseLngLat(s, flag);
    return { coord: c, id: null, name: `${c[0].toFixed(5)},${c[1].toFixed(5)}`, layer: null };
  }
  const m = s.match(/^([^:]+):(.+)$/);
  if (!m) throw new UsageError(`--${flag} "${s}" must be "lng,lat" or "<layer>:<featureId>" (e.g. hotels:via-loft)`);
  const [, layer, id] = m;
  if (!site) throw new UsageError(`--${flag} "${s}" is a layer ref but no site directory was given`);
  const fc = loadLayer(site, layer);
  const f = fc.features.find((x) => String(x?.properties?.id) === id);
  if (!f) {
    const ids = fc.features.map((x) => x?.properties?.id).filter(Boolean);
    const near = ids.filter((x) => x.includes(id) || id.includes(x)).slice(0, 5);
    throw new UserError(`--${flag} "${s}": no feature with id "${id}" in layer "${layer}" (${ids.length} features).` +
      (near.length ? ` Did you mean: ${near.join(', ')}?` : ids.length ? ` Some ids: ${ids.slice(0, 8).join(', ')}` : ''));
  }
  const coord = representativePoint(f.geometry);
  if (!coord) throw new UserError(`--${flag} "${s}": feature has no usable geometry`);
  return { coord, id, name: f.properties.name || id, layer, feature: f };
}

// Write a layer file this command owns. Refuses to replace a file written by something else unless --force.
// Call before any network work so a refusal is cheap.
export function assertOwned(site, id, cmd, force = false) {
  const p = layerPath(site, id);
  if (!exists(p) || force) return;
  let prev = null;
  try { prev = readJSON(p); } catch {}
  const prevCmd = prev?.uw?.cmd;
  if (prevCmd !== cmd) {
    throw new UserError(`${path.relative(site.dir, p)} already exists and was ${prevCmd ? `written by "${prevCmd}"` : 'not written by this command (hand-made?)'}.` +
      ` Use a different --layer, or pass --force to replace it.`);
  }
}
// coverage: { circles: [[lng, lat, radiusM], …] } the area the data was fetched for (enrich flags features outside it);
// partial: { reason, refetch } when the data is known to be incomplete (a fallback, a cap): enrich carries it into the
// metrics made from it and the verdict shows a caveat. A later complete run writes no partial, which clears it.
export function writeOwnedLayer(site, id, fc, { cmd, args = {}, force = false, out, coverage = null, partial = null }) {
  const p = layerPath(site, id);
  assertOwned(site, id, cmd, force);
  fc.uw = { cmd, generated_at: new Date().toISOString(), ...(Object.keys(args).length ? { args } : {}), ...(coverage ? { coverage } : {}), ...(partial ? { partial } : {}) };
  const bytes = writeGeoJSON(p, fc);
  if (bytes > 3 * 1024 * 1024)
    out?.warn(`${path.relative(site.dir, p)} is ${fmtBytes(bytes)} (> 3 MB). Phones will load it slowly; narrow the area, lower --limit or raise --simplify.`);
  return { path: p, rel: path.relative(site.dir, p).split(path.sep).join('/'), bytes };
}

// A hint printed after writing data for a layer the config does not declare yet.
export function layerHint(site, id, type, extra = {}) {
  if (configLayer(site, id)) return null;
  const { title, ...rest } = extra;
  return { id, title: title || titleCase(id), type, data: layerRelPath(site, id), ...rest };
}
// Register a layer a command just wrote (so it shows at once; no copy-paste step). `hint` comes from layerHint() and is
// null when the layer is already declared. No tier is written: with a question the engine makes it option, support or
// context by itself. `also(cfg)` may add related top-level keys (the feel grid's "vibe"). Returns a one-line note.
export function registerLayer(site, hint, { also } = {}) {
  if (!hint) return null;
  return withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    const layers = Array.isArray(cfg.layers) ? cfg.layers : [];
    if (layers.some((l) => l?.id === hint.id)) return null;
    cfg.layers = [...layers, hint];
    const extra = also ? also(cfg) : null;
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    return `map.config.json: registered layer "${hint.id}" (${hint.type})${extra ? `; ${extra}` : ''}.`;
  });
}
// Mark a config layer as partial ("partial": "<reason>") or clear the mark (reason null). Returns a note or null.
export function setLayerPartial(site, id, reason) {
  return withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    const l = (cfg.layers || []).find((x) => x?.id === id);
    if (!l || (reason ? l.partial === reason : l.partial === undefined)) return null;
    if (reason) l.partial = reason; else delete l.partial;
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    return reason ? `map.config.json: layer "${id}" marked partial (${reason}).` : `map.config.json: layer "${id}" is complete again (partial mark removed).`;
  });
}
// Append a credit line to map.config.json "attribution" when absent. Returns true when added.
export function addAttribution(site, text) {
  if (!site?.config) return false;
  return withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    const list = Array.isArray(cfg.attribution) ? cfg.attribution : [];
    if (list.includes(text)) return false;
    cfg.attribution = [...list, text];
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    return true;
  });
}
// Set a top-level config key when it is absent (photos, air). Returns a one-line note or null.
export function ensureConfigKey(site, key, value) {
  return withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    if (cfg[key] !== undefined) return null;
    cfg[key] = value;
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    return `map.config.json: added "${key}": ${JSON.stringify(value)}.`;
  });
}
export function titleCase(id) { return String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

export function viewBounds(site) {
  const b = site.config?.view?.bounds;
  if (Array.isArray(b) && b.length === 2 && Array.isArray(b[0]) && Array.isArray(b[1])) {
    const [[w, s], [e, n]] = b;
    if ([w, s, e, n].every(Number.isFinite) && w < e && s < n) return [w, s, e, n];
  }
  return null;
}
// Bounding box of a layer's features grown by growM metres ("--around hotels"): w,s,e,n.
export function layerBBox(site, id, growM = 0) {
  const fc = loadLayer(site, id);
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of fc.features) {
    if (!f?.geometry?.coordinates && !f?.geometry?.geometries) continue;
    const g = geomBBox(f.geometry);
    b[0] = Math.min(b[0], g[0]); b[1] = Math.min(b[1], g[1]); b[2] = Math.max(b[2], g[2]); b[3] = Math.max(b[3], g[3]);
  }
  if (!Number.isFinite(b[0])) throw new UserError(`layer "${id}" has no features to build an area around`);
  const lat0 = (b[1] + b[3]) / 2, kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110574;
  return [round6(b[0] - growM / kx), round6(b[1] - growM / ky), round6(b[2] + growM / kx), round6(b[3] + growM / ky)];
}
/** the starter's world view (no bounds, zoom < 4): `uw new` without --center; nothing is centred yet */
export function viewUnset(site) {
  const v = site.config?.view;
  return !v || (!Array.isArray(v.bounds) && !(Number(v.zoom) >= 4));
}
export function viewCenter(site) {
  const c = site.config?.view?.center;
  if (viewUnset(site)) return null;
  if (Array.isArray(c) && c.length === 2 && c.every(Number.isFinite) && !(c[0] === 0 && c[1] === 0)) return c;
  return null;
}
