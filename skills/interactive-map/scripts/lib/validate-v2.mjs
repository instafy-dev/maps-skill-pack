// v0.2 checks for `validate`: question, verdict (V1-V6), tiers, links, photos, bind, metrics.json, bound.json, records,
// OGDL credit, and the static signal rules S5 / S6 / S7 (ENGINE-SPEC-v0.2 §2.4, §9, §11.3).
// Shape errors in new keys are errors (v0 sites have none of them). Signal rules are warnings unless --signal.
import fs from 'node:fs';
import { adapterCredits } from '../adapters/lib/areas.mjs';
import path from 'node:path';
import { pointInPolygonGeom } from './util.mjs';
import { exists, readJSON } from './util.mjs';
import { SCRIPTS_DIR } from './site.mjs';
import { checkSchema, validate, fmtErrors } from './schema-lite.mjs';
import { checkMetrics, BASIS } from './metrics.mjs';
import { validateRecordsFile, MAX_FILE_BYTES, MAX_RECORDS } from './records.mjs';

export const V2_TOP_KEYS = ['question', 'verdict', 'links', 'photos', 'bind', 'signal', 'intents', 'missing'];
export const V2_LAYER_KEYS = ['tier', 'rank', 'budget', 'role', 'lens', 'expert', 'links', 'glow', 'labelZoom', 'numbered', 'partial'];
const KINDS = ['choose-one', 'find-area', 'plan-route', 'find-place', 'explore'];
const LINK_KINDS = ['google', 'streetview', 'apple', 'lookaround', 'directions', 'panoramax'];
const UI_RE = /^(card|card-more|sheet-header|map-context|list-row|compare-cell:[a-z][a-z0-9_]{0,47})$/;
const PREFILL_RE = /^\$(item\.(ref|id|layer|name|lnglat|[A-Za-z0-9_]{1,48})|pin\.lnglat|view\.(center|bbox|zoom)|state\.(hour|lens|weights)|options\.refs)$/;
const BANNED_EN = ['unsafe', 'dangerous', 'sketchy', 'dirty', 'illegal', 'unlicensed', 'bad area', 'crime'];
const BANNED_ZH = ['危險', '違法', '非法'];

export function bannedIn(text) {
  const t = String(text || '');
  const hits = BANNED_EN.filter((w) => new RegExp(`\\b${w.replace(' ', '\\s+')}`, 'i').test(t));
  for (const w of BANNED_ZH) if (t.includes(w)) hits.push(w);
  return hits;
}

// Default anchors (§1.4) for tie checks (also used by uw question).
export function anchors(meta, key) {
  const unit = meta.unit, fmt = meta.format;
  if (meta.threshold != null || meta.cap != null) return { threshold: meta.threshold ?? 0, cap: meta.cap ?? null };
  if (fmt === 'pct') return { threshold: 0.05, cap: null };
  if (unit === 'min' || /^(walk|ride)_min_/.test(key)) return { threshold: 2, cap: null };
  if (unit === 'm' || /_m$/.test(key)) return { threshold: 100, cap: null };
  if (unit === 'dB' || /_db/.test(key)) return { threshold: 3, cap: null };
  if (/_\d+min$|_\d+m$|blocks/.test(key) || unit === 'blocks') return { threshold: 3, cap: 20 };
  return { threshold: 0, cap: null };
}

// Formatted forms of a value the engine could show (V2): raw, rounded, %, km, thousands.
function forms(v, meta = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return [];
  const out = new Set([v, Math.round(v), Math.round(v * 10) / 10]);
  if (meta.format === 'pct' || (v >= 0 && v <= 1 && !meta.unit)) out.add(Math.round(v * 100));
  if (meta.unit === 'm' || v >= 1000) { out.add(Math.round(v / 100) / 10); out.add(Math.round(v / 1000)); }
  return [...out];
}
function numbersIn(text) {
  const s = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  return [...s.matchAll(/(?<![\p{L}\d])\d+(?:[.,]\d+)?(?![\p{L}\d])/gu)].map((m) => Number(m[0].replace(',', '.')));
}

export function checkV2(ctx) {
  const { dir, cfg, byId, featuresByLayer, E, W, args, CFG, Question } = ctx;
  const signal = !!args.signal, strict = !!args.strict;
  // signal rules: fail with --signal (S7 only with --strict), else warnings
  const SIG = (id, file, p, msg, fix, { warnOnly = false } = {}) => {
    const m = `${id} ${msg}`;
    if (signal && !(warnOnly && !strict)) E(file, p, m, fix); else W(file, p, m, fix);
  };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const feats = (id) => featuresByLayer.get(id) || [];
  const featById = (layer, id) => feats(layer).find((f) => String(f?.properties?.id) === String(id));
  const relOf = (p) => path.relative(dir, p).split(path.sep).join('/');

  // --- missing: places asked for that are not on the map yet ("Not found yet" line; add-point keeps it)
  if (cfg.missing !== undefined) {
    if (!Array.isArray(cfg.missing)) E(CFG, '$.missing', 'missing must be an array of { "name", "tried": [] }', 'add-point writes it; remove the key if empty');
    else {
      cfg.missing.forEach((m, i) => { if (!m || typeof m.name !== 'string' || !m.name) E(CFG, `$.missing[${i}].name`, 'each missing entry needs a name', ''); });
      const names = cfg.missing.map((m) => m?.name).filter(Boolean);
      if (names.length) W(CFG, '$.missing', `not found yet: ${names.join(', ')} (shown on the map)`, 'finish the map, then ask the user for these street addresses and add-point them (the entry clears itself)');
    }
  }

  // --- metrics.json
  let metrics = {};
  const mp = path.join(dir, 'data', 'metrics.json');
  if (exists(mp)) {
    try {
      const m = readJSON(mp);
      metrics = m.metrics || {};
      for (const pr of checkMetrics(m)) (pr.level === 'error' ? E : W)('data/metrics.json', pr.path, pr.message, pr.level === 'error' ? 'regenerate it with the command that wrote the metric' : 'add it in data/metrics.json');
    } catch (e) { E('data/metrics.json', '', `invalid JSON: ${e.message}`, 'regenerate it (enrich / areas / adapters write it)'); }
  }
  const metaOf = (key) => metrics[key] || {};
  // the option that ranks first, exactly as the engine ranks (same percentiles against the feel grid)
  const rankFirst = Question ? (q) => {
    try {
      const gridDef = (cfg.layers || []).find((l) => l?.type === 'grid');
      const g = gridDef ? feats(gridDef.id) : [];
      const pc = new Map();
      const percentile = (key, x) => {
        const field = String(key).replace(/_area$/, '');
        if (typeof x !== 'number' || !/^(calm_day|calm_night|lively_day|lively_night|green|amenities)$/.test(field)) return null;
        if (!pc.has(field)) { const v = g.filter((f) => !f.properties?.water).map((f) => f.properties?.[field]).filter((n) => typeof n === 'number').sort((a, b) => a - b); pc.set(field, v.length >= 20 ? v : null); }
        const vals = pc.get(field); if (!vals) return null;
        let lo = 0, hi = vals.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] <= x + 1e-9) lo = mid + 1; else hi = mid; }
        return lo / vals.length;
      };
      const Q = new Question(q, { metrics, compare: cfg.compare, verdict: cfg.verdict, features: (id) => feats(id), percentile });
      Q.lens = q.lens || null; Q.resolve();
      return Q.rankList()[0]?.o?.id ?? null;
    } catch { return null; }
  } : null;

  // --- records files (load once; also used for claim:<attr> criteria and OGDL)
  const recordFiles = [];
  const rdir = path.join(dir, 'data', 'records');
  if (exists(rdir)) {
    for (const f of fs.readdirSync(rdir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(rdir, f), rel = `data/records/${f}`;
      const size = fs.statSync(fp).size;
      let obj = null;
      try { obj = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { E(rel, '', `invalid JSON: ${e.message}`, 'delete it; uw host / the adapter rewrites it'); continue; }
      const errs = validateRecordsFile(obj);
      if (errs.length) E(rel, errs[0].path, `not a valid uw.records@1 file: ${fmtErrors(errs, 3)}`, 'records come from adapters and uw host only; regenerate rather than editing by hand');
      if (size > MAX_FILE_BYTES) E(rel, '', `${Math.round(size / 1024)} KB is over the 200 KB the engine accepts (it ignores the file)`, 'split it or drop old records');
      if ((obj.records || []).length > MAX_RECORDS) E(rel, '$.records', `${obj.records.length} records (max ${MAX_RECORDS})`, 'drop old records');
      let unknown = 0, first = null;
      for (const r of obj.records || []) {
        const ref = r.ref || (r.type === 'item' ? null : null);
        if (!ref) continue;
        const [l, ...rest] = String(ref).split(':'); const id = rest.join(':');
        const itemLayer = (obj.records || []).some((x) => x.type === 'item' && (x.layer === l) && x.iid === id);
        if (!itemLayer && !(byId.has(l) && featById(l, id))) { unknown++; first ??= ref; }
      }
      if (unknown) W(rel, '$.records', `${unknown} record(s) refer to items not on the map (e.g. ${first}); the engine keeps them hidden`, 'fine if those items arrive later; otherwise remove them');
      recordFiles.push({ rel, obj });
    }
  }
  const claimAttrs = new Map(); // ref → Set(attr)
  for (const { obj } of recordFiles) for (const r of obj.records || []) if (r.type === 'claim') { if (!claimAttrs.has(r.ref)) claimAttrs.set(r.ref, new Set()); claimAttrs.get(r.ref).add(r.attr); }
  const vj = path.join(dir, 'data', 'version.json');
  if (exists(vj)) {
    try {
      const v = readJSON(vj);
      if (!isNum(v.v) || (v.files && typeof v.files !== 'object') || (v.jobs && typeof v.jobs !== 'object')) E('data/version.json', '$', 'must be { "v": number, "files": { path: v }, "jobs": { id: state } }', 'delete it; uw host rewrites it');
      for (const [f, n] of Object.entries(v.files || {})) if (!isNum(n) || !exists(path.join(dir, f))) W('data/version.json', `$.files.${f}`, `lists "${f}" which ${isNum(n) ? 'does not exist' : 'has no version number'}`, 'harmless; the engine ignores a 404');
    } catch (e) { E('data/version.json', '', `invalid JSON: ${e.message}`, 'delete it; uw host rewrites it'); }
  }

  // --- version
  const usesV2 = cfg.question || exists(path.join(dir, 'bound.json')) || recordFiles.length;
  if (usesV2 && cfg.version !== 2) W(CFG, '$.version', 'this site uses v0.2 features (question, bound.json or records)', 'set "version": 2 (the engine treats 1 and 2 alike; 2 tells readers which spec applies)');

  // --- layers: v0.2 keys
  for (const [i, l] of (cfg.layers || []).entries()) {
    if (!l || typeof l !== 'object') continue;
    const p = `$.layers[${i}]`;
    if (l.tier !== undefined && !['option', 'support', 'context'].includes(l.tier)) E(CFG, `${p}.tier`, 'tier must be "option", "support" or "context"', 'context = small dots, hidden until a card mentions them');
    if (l.rank !== undefined && !isNum(l.rank)) E(CFG, `${p}.rank`, 'rank must be a number', '');
    if (l.budget !== undefined && !(Number.isInteger(l.budget) && l.budget >= 0)) E(CFG, `${p}.budget`, 'budget must be a whole number ≥ 0 (max pins of this layer)', '');
    if (l.role !== undefined && typeof l.role !== 'string') E(CFG, `${p}.role`, 'role must be a string (e.g. "verdict" for named areas)', '');
    if (l.expert !== undefined && typeof l.expert !== 'boolean') E(CFG, `${p}.expert`, 'expert must be true or false', '');
    if (l.glow !== undefined && typeof l.glow !== 'boolean') E(CFG, `${p}.glow`, 'glow must be true or false', '');
    if (l.style?.glow !== undefined && typeof l.style.glow !== 'boolean') E(CFG, `${p}.style.glow`, 'glow must be true or false', '');
    if (l.links !== undefined && l.links !== false && !(Array.isArray(l.links) && l.links.every((k) => LINK_KINDS.includes(k)))) E(CFG, `${p}.links`, `links must be false or a list of ${LINK_KINDS.join(', ')}`, '');
    // S5: something on the map must say what a layer is
    if (l.visible !== false && !l.title && !l.legend && l.tier !== 'option' && cfg.question?.options?.layer !== l.id && l.role !== 'verdict')
      SIG('S5', CFG, `${p}.title`, `layer "${l.id}" has no title or legend, so nothing on screen says what it is`, 'add "title" (shown in Layers with a swatch) or "legend"');
  }
  for (const [i, m] of (cfg.compare?.metrics || []).entries()) {
    const p = `$.compare.metrics[${i}]`;
    for (const k of ['threshold', 'cap']) if (m?.[k] !== undefined && !isNum(m[k])) E(CFG, `${p}.${k}`, `${k} must be a number`, '');
    if (m?.basis !== undefined && !BASIS.includes(m.basis)) E(CFG, `${p}.basis`, `basis must be one of ${BASIS.slice(0, 10).join(', ')}`, '');
    if (m?.always !== undefined && typeof m.always !== 'boolean') E(CFG, `${p}.always`, 'always must be true or false', '');
  }

  // --- question
  const q = cfg.question;
  let optLayer = null, optFeats = [];
  const critKeys = new Set();
  if (q !== undefined) {
    const P = '$.question';
    if (!q || typeof q !== 'object') E(CFG, P, 'question must be an object', 'scaffold it: uw question <site> --kind choose-one --options <layer> --criteria key:3,key:1');
    else {
      if (!KINDS.includes(q.kind)) E(CFG, `${P}.kind`, `kind must be one of ${KINDS.join(', ')}`, '');
      if (q.ask !== undefined && (typeof q.ask !== 'string' || [...q.ask].length > 70)) E(CFG, `${P}.ask`, 'ask must be a string of ≤ 70 characters (it is the sheet heading)', 'shorten it');
      const needsOptions = !['explore', 'plan-route'].includes(q.kind);
      if (needsOptions || q.options) {
        const o = q.options || {};
        if (!byId.has(o.layer)) E(CFG, `${P}.options.layer`, `options.layer ${JSON.stringify(o.layer)} is not a layer id`, `use one of: ${[...byId.keys()].join(', ')}`);
        else {
          optLayer = o.layer;
          optFeats = feats(o.layer);
          if (o.ids !== undefined) {
            if (!Array.isArray(o.ids)) E(CFG, `${P}.options.ids`, 'ids must be an array of feature ids', '');
            else {
              o.ids.forEach((id, j) => { if (!featById(o.layer, id)) E(CFG, `${P}.options.ids[${j}]`, `no ${o.layer} feature "${id}"`, ''); });
              optFeats = o.ids.map((id) => featById(o.layer, id)).filter(Boolean);
            }
          }
          if (o.letters !== undefined && !['given', 'rank', false].includes(o.letters)) E(CFG, `${P}.options.letters`, 'letters must be "given", "rank" or false', '');
          if (o.top !== undefined && !(Number.isInteger(o.top) && o.top >= 1 && o.top <= 5)) E(CFG, `${P}.options.top`, 'top must be 1-5 (the lettered options A-E; the rest are dots, all of them in Places)', '');
          if (o.noun !== undefined && typeof o.noun !== 'string') E(CFG, `${P}.options.noun`, 'noun must be a string ("independent cafés"): it reads "Top 5 of 445 <noun>"', '');
          if (q.kind === 'choose-one' && (optFeats.length < 2 || optFeats.length > 5)) W(CFG, `${P}.options`, `choose-one needs 2-5 options (has ${optFeats.length})`, 'use options.ids or kind "find-place"');
          if (q.kind === 'find-place' && o.top) optFeats = optFeats.slice(0, o.top);
        }
      }
      const crit = Array.isArray(q.criteria) ? q.criteria : [];
      if (q.criteria !== undefined && !Array.isArray(q.criteria)) E(CFG, `${P}.criteria`, 'criteria must be an array', '');
      if (crit.length > 6) E(CFG, `${P}.criteria`, `${crit.length} criteria (max 6): choosing needs few dimensions`, 'keep the ones that differ between options');
      if (needsOptions && !crit.length && q.kind !== 'find-area') E(CFG, `${P}.criteria`, 'no criteria: nothing to rank or explain', 'add 2-4 criteria from data/metrics.json');
      crit.forEach((c, j) => {
        const p = `${P}.criteria[${j}]`;
        if (!c || typeof c.key !== 'string') { E(CFG, `${p}.key`, 'criterion needs a "key"', ''); return; }
        critKeys.add(c.key);
        if (c.weight !== undefined && !(isNum(c.weight) && c.weight >= 0)) E(CFG, `${p}.weight`, 'weight must be a number ≥ 0', '0 = shown, may lead a verdict, does not rank');
        if (c.phrase !== undefined && (typeof c.phrase !== 'object' || ['lead', 'value', 'worst', 'cross', 'zero'].some((k) => c.phrase[k] !== undefined && typeof c.phrase[k] !== 'string')))
          E(CFG, `${p}.phrase`, 'phrase must be { "lead": "…", "value": "… {value} …", "worst": "… {value}", "zero": "…" } (strings)', '');
        for (const k of Object.keys(c.phrase || {})) if (!['lead', 'value', 'worst', 'cross', 'zero'].includes(k)) W(CFG, `${p}.phrase.${k}`, `unknown phrase "${k}"`, 'phrases: lead, value, worst, cross, zero');
        for (const k of ['good', 'bad', 'threshold', 'cap']) if (c[k] !== undefined && !isNum(c[k])) E(CFG, `${p}.${k}`, `${k} must be a number`, '');
        if (c.basis !== undefined && !BASIS.includes(c.basis)) E(CFG, `${p}.basis`, 'unknown basis', '');
        for (const t of [c.label, c.phrase?.lead, c.phrase?.value, c.phrase?.worst, c.phrase?.zero]) for (const w of bannedIn(t)) E(CFG, p, `V4 banned word "${w}" in criterion text`, 'describe what was measured, never judge a place');
        if (!optFeats.length) return;
        const claim = c.key.startsWith('claim:') ? c.key.slice(6) : null;
        // named areas (find-area) keep their scores in "mean", like the engine's Question.value()
        const own = (f) => f.properties[c.key] ?? (f.properties.mean && typeof f.properties.mean === 'object' ? f.properties.mean[c.key] : undefined);
        const val = (f) => (claim ? (claimAttrs.get(`${optLayer}:${f.properties.id}`)?.has(claim) ? 1 : undefined) : own(f));
        const have = optFeats.filter((f) => (claim ? val(f) !== undefined : isNum(val(f))));
        if (!have.length) E(CFG, `${p}.key`, `no option has ${claim ? `a "${claim}" claim` : `a numeric "${c.key}"`}`, claim ? 'run the adapter with --records or the intent first' : 'run the command that writes it (enrich, areas, doorstep or an adapter)');
        else if (have.length < optFeats.length) W(CFG, `${p}.key`, `"${c.key}" missing on ${optFeats.length - have.length} option(s): shown as "—", counted as average with low confidence`, 're-run the command that writes it');
        if (!claim && !metrics[c.key] && exists(mp)) W(CFG, `${p}.key`, `"${c.key}" has no metrics.json entry: label, unit and basis are guessed`, 'run the command that writes it again (v0.2 scripts record metrics.json)');
        // V6: auto verdicts need values on ≥ 2 options
        if ((q.verdict?.mode ?? cfg.verdict?.mode ?? 'auto') === 'auto' && have.length < 2 && optFeats.length >= 2) W(CFG, `${p}.key`, `V6 "${c.key}" has a value on ${have.length} option(s); it cannot tell options apart`, 'drop it or fill it in');
        // S6: all options tie
        if (!claim && have.length >= 2) {
          const meta = { ...metaOf(c.key), ...c };
          const { threshold, cap } = anchors(meta, c.key);
          const vals = have.map((f) => own(f));
          const tie = (Math.max(...vals) - Math.min(...vals) < threshold) || (cap != null && vals.every((v) => v >= cap)) || vals.every((v) => v === vals[0]);
          if (tie) SIG('S6', CFG, `${p}.key`, `"${c.key}" ties on every option (${vals.join(' / ')}, threshold ${threshold}${cap != null ? `, cap ${cap}` : ''}); ${c.always === true ? 'shown anyway ("always")' : 'the engine hides that row'}`, c.always === true ? 'fine when people expect to see it' : 'drop the criterion, or set "always": true if people expect to see it', { warnOnly: c.always === true });
        }
      });
      const lenses = Array.isArray(q.lenses) ? q.lenses : [];
      if (q.lenses !== undefined && !Array.isArray(q.lenses)) E(CFG, `${P}.lenses`, 'lenses must be an array', '');
      if (lenses.length > 4) E(CFG, `${P}.lenses`, `${lenses.length} lenses (max 4)`, 'keep the 2-3 that change the answer');
      const areaLenses = new Set();
      for (const [id, l] of byId) if (l.type === 'areas') for (const f of feats(id)) if (f?.properties?.lens) areaLenses.add(f.properties.lens);
      const lensIds = new Set();
      lenses.forEach((L, j) => {
        const p = `${P}.lenses[${j}]`;
        if (!L || typeof L.id !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(L.id)) { E(CFG, `${p}.id`, 'lens needs an id (lowercase, ≤ 24 chars; it goes in the URL as l=<id>)', ''); return; }
        if (lensIds.has(L.id)) E(CFG, `${p}.id`, `duplicate lens id "${L.id}"`, '');
        lensIds.add(L.id);
        if (!L.label) W(CFG, `${p}.label`, 'lens without label', 'the chip shows emoji + label');
        if (L.time !== undefined && !(isNum(L.time) && L.time >= 0 && L.time <= 30)) E(CFG, `${p}.time`, 'time must be an hour 0-30', '');
        if (L.vibe !== undefined && !(isNum(L.vibe) && L.vibe >= 0 && L.vibe <= 1)) E(CFG, `${p}.vibe`, 'vibe must be 0-1', '');
        for (const [k, w] of Object.entries(L.weights || {})) {
          if (!critKeys.has(k)) W(CFG, `${p}.weights.${k}`, `"${k}" is not a criterion, so this weight does nothing`, `criteria: ${[...critKeys].join(', ')}`);
          if (!(isNum(w) && w >= 0)) E(CFG, `${p}.weights.${k}`, 'weights must be numbers ≥ 0', '');
        }
        for (const k of ['show', 'hide']) for (const id of L[k] || []) if (!byId.has(id)) E(CFG, `${p}.${k}`, `"${id}" is not a layer id`, `layers: ${[...byId.keys()].join(', ')}`);
        for (const a of L.areas || []) if (areaLenses.size && !areaLenses.has(a)) W(CFG, `${p}.areas`, `no area has lens "${a}"`, `run: uw areas <site> --lens ${a}`);
        if (L.budget !== undefined) checkBudget(L.budget, `${p}.budget`);
      });
      if (q.lens !== undefined && q.lens !== null && !lensIds.has(q.lens)) E(CFG, `${P}.lens`, `starting lens "${q.lens}" is not in lenses`, '');
      // watched surroundings (a night market near an option): a measured key on the options, ≤ 4 entries
      const watch = q.watch;
      if (watch !== undefined) {
        if (!Array.isArray(watch) || watch.length > 4) E(CFG, `${P}.watch`, 'watch must be an array of ≤ 4 { key, within, label, hours?, lenses? }', '');
        else watch.forEach((w, j) => {
          const p = `${P}.watch[${j}]`;
          if (!w || typeof w.key !== 'string') { E(CFG, `${p}.key`, 'watch entry needs a "key" (e.g. nearest_nightmarkets_m)', 'uw enrich <site> --layer <options> --nearest <layer>'); return; }
          if (optFeats.length && !optFeats.some((f) => isNum(f.properties[w.key]))) W(CFG, `${p}.key`, `no option has a numeric "${w.key}"`, `run: uw enrich <site> --layer ${optLayer} --nearest ${w.key.replace(/^nearest_|_m$/g, '')}`);
          if (w.within !== undefined && !(isNum(w.within) && w.within > 0 && w.within <= 3000)) E(CFG, `${p}.within`, 'within must be metres (1-3000)', '');
          if (w.hours !== undefined && typeof w.hours !== 'string') E(CFG, `${p}.hours`, 'hours must be a property name', '');
          for (const id of Array.isArray(w.lenses) ? w.lenses : []) if (!lensIds.has(id)) E(CFG, `${p}.lenses`, `"${id}" is not a lens id`, '');
          for (const t of [w.label]) for (const b of bannedIn(t)) E(CFG, p, `V4 banned word "${b}" in watch label`, 'describe what is there, never judge a place');
        });
      }
      // letters follow the answer: under the starting lens, A should rank first (uw question writes options.ids in rank order)
      if (q.kind === 'choose-one' && (q.options?.letters ?? 'given') === 'given' && Array.isArray(q.options?.ids) && rankFirst) {
        const first = rankFirst(q);
        if (first && first !== String(q.options.ids[0])) W(CFG, `${P}.options.ids`, `"${first}" ranks first${q.lens ? ` under "${q.lens}"` : ''} but is lettered ${'ABCDE'[q.options.ids.map(String).indexOf(first)] || '?'}: people read A as the pick`, 're-run uw question … --force (letters by rank), or set options.letters "given" on purpose');
      }
      if (q.budget !== undefined) checkBudget(q.budget, `${P}.budget`);
      const personas = lenses.filter((l) => l.persona).length;
      if (lenses.length && personas === 1) W(CFG, `${P}.lenses`, 'only one lens has a persona; the persona line needs ≥ 2 that can disagree', 'add "persona" to another lens or remove it');
    }
  }
  function checkBudget(b, p) {
    if (!b || typeof b !== 'object') { E(CFG, p, 'budget must be { "option": 5, "support": 10, "context": 80 }', ''); return; }
    for (const k of Object.keys(b)) if (!['option', 'support', 'context'].includes(k)) E(CFG, `${p}.${k}`, `unknown budget tier "${k}"`, 'use option, support, context');
    for (const k of ['option', 'support', 'context']) if (b[k] !== undefined && !(Number.isInteger(b[k]) && b[k] >= 0)) E(CFG, `${p}.${k}`, 'budget values are whole numbers ≥ 0', '');
    if (optFeats.length && Number.isInteger(b.option) && b.option < Math.min(optFeats.length, 5)) E(CFG, `${p}.option`, `option budget ${b.option} hides some of the ${optFeats.length} options`, `raise it to ≥ ${Math.min(optFeats.length, 5)}`);
  }

  // --- verdict (V1-V5) + authored why lines
  const verdict = cfg.verdict;
  const checkLine = (line, p, { needRef = true, file = CFG } = {}) => {
    const EL = (f, ...rest) => E(f === CFG ? file : f, ...rest);
    if (!line || typeof line !== 'object') { EL(CFG, p, 'line must be an object { ref, text, cites }', ''); return; }
    let feat = null;
    if (needRef) {
      const m = String(line.ref || '').match(/^([^:]+):(.+)$/);
      if (!m || !optLayer || m[1] !== optLayer || !optFeats.some((f) => String(f.properties.id) === m[2])) EL(CFG, `${p}.ref`, `V5 ref ${JSON.stringify(line.ref)} is not an option`, `use "${optLayer || '<options layer>'}:<id>" of one of the options`);
      else feat = featById(m[1], m[2]);
    }
    const cites = Array.isArray(line.cites) ? line.cites : [];
    if (!cites.length) EL(CFG, `${p}.cites`, 'V1 no "cites": every authored line must name the metrics it states', 'list the metric keys, e.g. ["walk_min_mrt"]');
    for (const k of cites) if (!critKeys.has(k) && !(feat && feat.properties[k] !== undefined) && !metrics[k]) EL(CFG, `${p}.cites`, `V1 cited "${k}" is neither a criterion nor a metric on ${line.ref || 'the item'}`, '');
    const text = String(line.text ?? '');
    if (feat) {
      const allowed = cites.flatMap((k) => forms(feat.properties[k], metaOf(k)));
      for (const n of numbersIn(text)) if (!allowed.some((a) => Math.abs(a - n) < 1e-9)) EL(CFG, `${p}.text`, `V2 the number ${n} in "${text}" does not match any cited metric on ${line.ref}`, `values: ${cites.map((k) => `${k}=${feat.properties[k]}`).join(', ')}`);
    }
    if (cites.some((k) => ['estimated', 'modelled', 'inferred'].includes(metaOf(k).basis)) && !/\best\b/i.test(text)) EL(CFG, `${p}.text`, `V3 "${text}" cites an estimate but does not say "est."`, 'append " (est.)"');
    for (const w of bannedIn(text)) EL(CFG, `${p}.text`, `V4 banned word "${w}"`, 'say what was measured; never judge a place');
  };
  if (verdict !== undefined) {
    if (!verdict || typeof verdict !== 'object') E(CFG, '$.verdict', 'verdict must be an object', '{ "mode": "auto" }');
    else {
      if (verdict.mode !== undefined && !['auto', 'authored'].includes(verdict.mode)) E(CFG, '$.verdict.mode', 'mode must be "auto" or "authored"', '');
      if (verdict.facts !== undefined && !(Number.isInteger(verdict.facts) && verdict.facts >= 1 && verdict.facts <= 3)) E(CFG, '$.verdict.facts', 'facts must be 1-3', '');
      if (verdict.persona !== undefined && typeof verdict.persona !== 'boolean') E(CFG, '$.verdict.persona', 'persona must be true or false', '');
      if (verdict.mode === 'authored' && !(verdict.lines || []).length) E(CFG, '$.verdict.lines', 'authored mode needs lines', '');
      if (!q) W(CFG, '$.verdict', 'verdict without question', 'add a question block (uw question)');
      (verdict.lines || []).forEach((l, j) => checkLine(l, `$.verdict.lines[${j}]`));
    }
  }
  const whyLines = (arr, p, ref) => (Array.isArray(arr) ? arr : []).forEach((l, j) => checkLine({ ...l, ref }, `${p}[${j}]`, { needRef: false }));
  if (q?.why && typeof q.why === 'object') for (const [id, arr] of Object.entries(q.why)) whyLines(arr, `$.question.why.${id}`, `${optLayer}:${id}`);

  // --- V4 + S7 over data text (why, verdict, note, area names)
  const labelsEn = ['en', 'both'].includes(cfg.basemap?.labels ?? 'en');
  for (const [id, l] of byId) {
    const file = typeof l.data === 'string' ? l.data : CFG;
    feats(id).forEach((f, k) => {
      const pr = f?.properties || {};
      for (const key of ['why', 'verdict', 'note', 'tagline']) {
        const v = pr[key];
        const texts = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [v]; // line objects: checkLine below
        for (const t of texts) for (const w of bannedIn(t)) E(file, `$.features[${k}].properties.${key}`, `V4 banned word "${w}"`, 'describe what was measured; never judge a place');
      }
      if (Array.isArray(pr.why) && pr.why.some((x) => x && typeof x === 'object')) {
        const isOpt = id === optLayer;
        pr.why.forEach((x, j) => { if (x && typeof x === 'object') checkLine({ ...x, ref: `${id}:${pr.id}` }, `$.features[${k}].properties.why[${j}]`, { needRef: isOpt, file }); });
      }
    });
  }
  (cfg.notes || []).forEach((n, i) => { for (const w of bannedIn(n?.text)) E(CFG, `$.notes[${i}].text`, `V4 banned word "${w}"`, 'describe what was measured; never judge a place'); });
  // S7: names without English where the map is labelled in English
  if (labelsEn) {
    const noEn = [];
    for (const f of optFeats) if (!f.properties.name_en && /[㐀-鿿]/.test(f.properties.name || '')) noEn.push(`${optLayer}:${f.properties.id}`);
    for (const [id, l] of byId) for (const f of feats(id)) if (f?.properties?.needs_english && !/[A-Za-z]/.test(f.properties.name_en || '') && l.visible !== false) noEn.push(`${id}:${f.properties.id}`);
    if (noEn.length) SIG('S7', CFG, '$.basemap.labels', `${noEn.length} label(s) without English on an English map: ${noEn.slice(0, 5).join(', ')}${noEn.length > 5 ? ', …' : ''}`,
      'add name_en (uw set <site> <layer>:<id> --props \'{"name_en":"…"}\', or --names on areas / tw-night-markets); romanise, never invent', { warnOnly: true });
  }

  // --- links
  if (cfg.links !== undefined) {
    const L = cfg.links;
    if (!L || typeof L !== 'object') E(CFG, '$.links', 'links must be an object', '{ "show": ["streetview", "google", "directions"] }');
    else {
      if (L.show !== undefined && !(Array.isArray(L.show) && L.show.every((k) => LINK_KINDS.includes(k)))) E(CFG, '$.links.show', `show must list link kinds: ${LINK_KINDS.join(', ')}`, '');
      for (const id of L.layers || []) {
        if (!byId.has(id)) { E(CFG, '$.links.layers', `"${id}" is not a layer id`, ''); continue; }
        const bad = feats(id).filter((f) => !f?.geometry || !/Point|Polygon|LineString/.test(f.geometry.type || '')).length;
        if (bad) E(byId.get(id).data, '$.features', `${bad} feature(s) in "${id}" have no geometry for link-outs`, '');
      }
      if (L.lookaround !== undefined && typeof L.lookaround !== 'boolean') E(CFG, '$.links.lookaround', 'lookaround must be true or false', '');
      const d = L.directions;
      if (d !== undefined) {
        if (typeof d !== 'object') E(CFG, '$.links.directions', 'directions must be an object', '');
        else {
          if (d.to !== undefined && d.to !== 'here') E(CFG, '$.links.directions.to', 'to must be "here"', '');
          if (d.mode !== undefined && !['transit', 'walking', 'driving', 'bicycling'].includes(d.mode)) E(CFG, '$.links.directions.mode', 'mode must be transit, walking, driving or bicycling', '');
          if (d.from !== undefined) { if (!byId.has(d.from?.layer) || !featById(d.from.layer, d.from.id)) E(CFG, '$.links.directions.from', `from ${JSON.stringify(d.from)} does not resolve to a feature`, '{ "layer": "sights", "id": "taipei-main" }'); }
          if (d.label !== undefined && (typeof d.label !== 'string' || d.label.length > 40)) E(CFG, '$.links.directions.label', 'label must be a short string', '');
        }
      }
    }
  }

  // --- photos
  const photosCfg = cfg.photos;
  const photosPath = typeof photosCfg?.data === 'string' ? photosCfg.data : 'data/photos.json';
  if (photosCfg !== undefined && (typeof photosCfg !== 'object' || !photosCfg)) E(CFG, '$.photos', 'photos must be an object', '{ "data": "data/photos.json", "layers": ["hotels"] }');
  if (photosCfg?.viewer !== undefined && !['builtin', 'pannellum', 'link'].includes(photosCfg.viewer)) E(CFG, '$.photos.viewer', 'viewer must be "builtin" (default), "pannellum" or "link"', '');
  if (photosCfg?.viewer === 'pannellum' && !exists(path.join(dir, 'engine', 'vendor', 'pannellum', 'pannellum.js'))) W(CFG, '$.photos.viewer', 'engine/vendor/pannellum is not present; the engine falls back to its built-in 360° viewer', 'drop "viewer" (built-in is the default)');
  for (const id of photosCfg?.layers || []) if (!byId.has(id)) E(CFG, '$.photos.layers', `"${id}" is not a layer id`, '');
  if (exists(path.join(dir, photosPath))) {
    try {
      const ph = readJSON(path.join(dir, photosPath));
      if (!ph.attribution) E(photosPath, '$.attribution', 'no attribution', 're-run: uw photos …');
      let incomplete = 0, first = null;
      for (const [ref, it] of Object.entries(ph.items || {})) {
        const [l, id] = ref.split(':');
        if (!byId.has(l) || !featById(l, id)) W(photosPath, `$.items.${ref}`, `"${ref}" is not on the map`, `re-run photos for layer ${l}`);
        for (const p of [it.photo, ...(it.alternates || [])].filter(Boolean)) {
          const miss = ['author', 'licence', 'captured_at', 'viewer_url', 'thumb_url'].filter((k) => !p[k]);
          if (miss.length) { incomplete++; first ??= `${ref} (${miss.join(', ')})`; }
          if (p.thumb_url && !/^https:\/\//.test(p.thumb_url)) E(photosPath, `$.items.${ref}`, 'photo URLs must be https', '');
        }
        if (it.status && !['found', 'none'].includes(it.status)) E(photosPath, `$.items.${ref}.status`, 'status must be found or none', '');
      }
      if (incomplete) SIG('PHOTO', photosPath, '$.items', `${incomplete} photo(s) without full credit (author, licence, date, viewer link): e.g. ${first}`, 'CC BY-SA needs every credit: re-run uw photos (it drops nothing silently)');
    } catch (e) { E(photosPath, '', `invalid JSON: ${e.message}`, 're-run uw photos'); }
  } else if (photosCfg?.data) E(CFG, '$.photos.data', `"${photosPath}" not found`, 'run: uw photos <site> --layer <id>');

  // --- bind / signal
  if (cfg.bind !== undefined && cfg.bind !== true && cfg.bind !== false) {
    if (!cfg.bind || typeof cfg.bind !== 'object') E(CFG, '$.bind', 'bind must be true or an object', '{ "parentOrigins": ["https://instafy.dev"] }');
    else {
      for (const k of Object.keys(cfg.bind)) if (!['parentOrigins', 'manifest', 'results', 'host', 'siteId'].includes(k)) W(CFG, `$.bind.${k}`, `unknown bind key "${k}" (ignored)`, 'known: parentOrigins, manifest, results, host, siteId');
      if (cfg.bind.parentOrigins !== undefined && !(Array.isArray(cfg.bind.parentOrigins) && cfg.bind.parentOrigins.every((o) => /^https?:\/\/[^/]+$/.test(o))))
        E(CFG, '$.bind.parentOrigins', 'parentOrigins must be origins like "https://instafy.dev" (no path)', '');
      if (cfg.bind.manifest !== undefined && cfg.bind.manifest !== false && !(typeof cfg.bind.manifest === 'string' && /\.json$/.test(cfg.bind.manifest) && !cfg.bind.manifest.includes('..')))
        E(CFG, '$.bind.manifest', 'manifest must be a site path to a .json file, or false', '"bound.json"');
      if (cfg.bind.host !== undefined && typeof cfg.bind.host !== 'boolean') E(CFG, '$.bind.host', 'host must be true or false', '');
    }
  }
  if (exists(path.join(dir, 'bound.json')) && (cfg.bind === undefined || cfg.bind === false))
    W(CFG, '$.bind', 'bound.json exists but map.config.json has no "bind": only `uw host` loads it then; Instafy and static hosts show no intent buttons and no results', 'add "bind": true');
  if (cfg.signal !== undefined && (typeof cfg.signal !== 'object' || !cfg.signal)) E(CFG, '$.signal', 'signal must be an object', '');

  // --- intents: bound.json (canonical) and map.config.json "intents"
  const boundSchema = readJSON(path.join(SCRIPTS_DIR, 'schemas', 'bound.schema.json'));
  const checkIntent = (name, def, file, p) => {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(name)) E(file, p, `intent name "${name}" must be lowercase letters, digits and _`, '');
    const errs = validate(boundSchema.$defs.intent, def, { root: boundSchema, max: 6 });
    if (errs.length) { E(file, p + errs[0].path.slice(1), fmtErrors(errs, 3), 'see ENGINE-SPEC-v0.2 §9.1'); }
    if (!def || typeof def !== 'object') return;
    const sch = checkSchema(def.params || {}, { path: `${p}.params` });
    for (const pr of sch) E(file, pr.path, pr.message, 'params use the JSON-Schema subset of §9.2; unknown keywords are not allowed (so no constraint is silently ignored)');
    if (def.params && def.params.type !== 'object') E(file, `${p}.params.type`, 'params must be an object schema', '"type": "object"');
    const props = def.params?.properties || {};
    for (const [k, v] of Object.entries(def.prefill || {})) {
      if (!(k in props)) E(file, `${p}.prefill.${k}`, `prefills "${k}" which params does not declare`, `declare it in params.properties or remove it`);
      for (const tok of String(v).split('|')) if (tok.startsWith('$') && !PREFILL_RE.test(tok)) E(file, `${p}.prefill.${k}`, `unknown prefill token "${tok}"`, '$item.ref|id|layer|name|lnglat|<prop>, $pin.lnglat, $view.center|bbox|zoom, $state.hour|lens|weights, $options.refs');
    }
    for (const u of def.ui || []) if (!UI_RE.test(u)) E(file, `${p}.ui`, `unknown ui placement "${u}"`, 'card, card-more, sheet-header, map-context, list-row, compare-cell:<attr>');
    // a layer another intent creates at run time (target.create) counts: "Check licence" on hotels found nearby
    const created = new Set(Object.values({ ...(cfg.intents || {}), ...(bound?.intents || {}) }).filter((d) => d?.target?.create && d.target.layer).map((d) => d.target.layer));
    for (const l of def.layers || []) if (!byId.has(l) && !created.has(l)) E(file, `${p}.layers`, `"${l}" is not a layer id (nor a layer an intent creates)`, '');
    if ((def.ui || []).includes('card') && !(def.layers || []).length) W(file, `${p}.layers`, 'card buttons need "layers" (which items get the button)', 'e.g. "layers": ["hotels"]');
    const t = def.target || {};
    if (t.layer && !byId.has(t.layer) && !t.create) W(file, `${p}.target.layer`, `results go to layer "${t.layer}", which does not exist and has no "create"`, 'add the layer, or "create": { "type": "points", "title": "…" }');
    if (def.handler !== undefined) {
      let hp = null;
      if (/^pack:/.test(def.handler)) hp = path.join(SCRIPTS_DIR, 'handlers', def.handler.slice(5) + '.mjs');
      else { hp = path.resolve(dir, def.handler); if (!hp.startsWith(dir + path.sep)) hp = null; }
      if (!hp || !exists(hp)) E(file, `${p}.handler`, `handler "${def.handler}" cannot be resolved`, `pack handlers: ${listHandlers().join(', ') || '(none)'}; or a site path like "handlers/x.mjs"`);
    }
    const lim = JSON.stringify(def.params || {}).length;
    if (lim > 4096) E(file, `${p}.params`, 'params schema over 4 KB', '');
  };
  const bp = path.join(dir, 'bound.json');
  let bound = null;
  if (exists(bp)) {
    try { bound = readJSON(bp); } catch (e) { E('bound.json', '', `invalid JSON: ${e.message}`, 'fix the syntax'); }
    if (bound) {
      const top = validate({ ...boundSchema, properties: { ...boundSchema.properties, intents: { type: 'object' } } }, bound, { root: boundSchema, max: 6 });
      if (top.length) E('bound.json', top[0].path, fmtErrors(top, 3), 'see ENGINE-SPEC-v0.2 §9.1');
      for (const [name, def] of Object.entries(bound.intents || {})) checkIntent(name, def, 'bound.json', `$.intents.${name}`);
      const files = new Set(bound.results?.files || []);
      for (const [name, def] of Object.entries(bound.intents || {})) if (def?.target?.records && !files.has(def.target.records)) W('bound.json', `$.intents.${name}.target.records`, `"${def.target.records}" is not in results.files, so late joiners do not load it at start`, 'add it to results.files');
      if (!Object.keys(bound.intents || {}).length) W('bound.json', '$.intents', 'no intents declared', '');
    }
  }
  if (cfg.intents !== undefined) {
    if (!cfg.intents || typeof cfg.intents !== 'object' || Array.isArray(cfg.intents)) E(CFG, '$.intents', 'intents must be an object keyed by intent name', '');
    else for (const [name, def] of Object.entries(cfg.intents)) {
      if (bound?.intents?.[name]) W(CFG, `$.intents.${name}`, `"${name}" is also in bound.json, which wins`, 'remove one of them');
      checkIntent(name, def, CFG, `$.intents.${name}`);
    }
  }

  // --- A1: a "quiet" named area must not contain a place that is loud in its own hours (a night market 18:00-00:00)
  {
    const loud = [];
    for (const [id, l] of byId) if (l.type === 'points') for (const f of feats(id)) if (f?.geometry?.type === 'Point' && /night_?market/.test(String(f.properties?.kind || ''))) loud.push(f);
    for (const [id, l] of byId) {
      if (l.type !== 'areas') continue;
      for (const a of feats(id)) {
        const pa = a?.properties || {};
        if (!/^quiet|calm/.test(String(pa.lens || '')) || !a.geometry) continue;
        const win = [pa.time_from ?? 0, pa.time_to ?? 24];
        for (const m of loud) {
          const pm = m.properties;
          const open = pm.time_from == null || pm.time_to == null || [0, 24, -24].some((k) => pm.time_from + k < win[1] && (pm.time_to > pm.time_from ? pm.time_to : pm.time_to + 24) + k > win[0]);
          if (open && pointInPolygonGeom(m.geometry.coordinates, a.geometry)) SIG('A1', `data/${id}.geojson`, `$.features[?(@.properties.id=="${pa.id}")]`, `"${pa.verdict || 'quiet'}" area ${pa.id} contains ${pm.name_en || pm.name} (${pm.kind}${pm.time_from != null ? `, ${pm.time_from}:00-${pm.time_to % 24}:00` : ''})`, 're-run uw areas (it leaves out cells next to night markets open in the lens hours)');
        }
      }
    }
  }

  // --- open-data credits (a licence such as Taiwan's OGDL is void without its attribution): every adapter whose data
  // is on the map (its property prefix on a feature, or its source on a record) needs its credit in the attribution
  const attr = JSON.stringify([cfg.attribution || [], ...[...byId.values()].map((l) => l.attribution || '')]);
  for (const credit of adapterCredits()) {
    const { propPrefix, recordSource } = credit.marks;
    const onProps = propPrefix && [...featuresByLayer.values()].some((fs2) => fs2.some((f) => f?.properties && Object.keys(f.properties).some((k) => k.startsWith(propPrefix))));
    const onRecords = recordSource && recordFiles.some(({ obj }) => (obj.records || []).some((r) => recordSource.test(r?.prov?.source || '')));
    if ((onProps || onRecords) && !credit.re.test(attr)) {
      E(CFG, '$.attribution', `open data from ${credit.names.join(' / ')} (${onProps ? `${propPrefix}* properties` : 'its records'}) is shown without the credit its licence requires`,
        `add its credit, e.g. "${credit.texts[0]}" (the adapter adds it when it runs)`);
    }
  }
  // licence objects never say "illegal"/"unlicensed"
  for (const [id] of byId) feats(id).forEach((f, k) => {
    const lic = f?.properties?.licence;
    if (!lic) return;
    if (!['registered', 'uncertain', 'not_found'].includes(lic.status)) E(byId.get(id).data, `$.features[${k}].properties.licence.status`, 'licence.status must be registered, uncertain or not_found', '');
    if (lic.status === 'registered' && lic.confidence && lic.confidence !== 'high') E(byId.get(id).data, `$.features[${k}].properties.licence`, `a ${lic.confidence}-confidence match must be "uncertain", never "registered"`, 're-run the adapter');
    for (const w of bannedIn(lic.label)) E(byId.get(id).data, `$.features[${k}].properties.licence.label`, `V4 banned word "${w}"`, 'a miss is "Not found in register"');
  });
  return { metrics, recordFiles, bound };
}

export function listHandlers() {
  try { return fs.readdirSync(path.join(SCRIPTS_DIR, 'handlers')).filter((f) => f.endsWith('.mjs')).map((f) => 'pack:' + f.replace(/\.mjs$/, '')); } catch { return []; }
}
