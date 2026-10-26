// data/metrics.json: the metric registry (ENGINE-SPEC-v0.2 §0.4). Scripts write; the engine and validate read.
// Merged by key, never overwritten wholesale.
import path from 'node:path';
import { readJSON, writeJSON, exists } from './util.mjs';

export const BASIS = ['measured', 'routed', 'counted', 'estimated', 'registry', 'filed', 'live', 'brand', 'user_note', 'editorial', 'modelled', 'inferred'];
export const METRIC_KEYS = ['label', 'short', 'unit', 'format', 'better', 'basis', 'confidence', 'source', 'scale', 'layer', 'id_key', 'good', 'bad',
  'threshold', 'cap', 'as_of', 'cmd', 'note', 'display'];

export function metricsPath(siteDir) { return path.join(siteDir, 'data', 'metrics.json'); }

export function readMetrics(siteDir) {
  const p = metricsPath(siteDir);
  if (!exists(p)) return { uw: { cmd: 'metrics' }, metrics: {} };
  try {
    const m = readJSON(p);
    if (!m || typeof m !== 'object' || typeof m.metrics !== 'object') return { uw: { cmd: 'metrics' }, metrics: {} };
    return m;
  } catch { return { uw: { cmd: 'metrics' }, metrics: {} }; }
}

// entries: { key: { label, unit, basis, … } }. Existing fields not given are kept (so a hand-tuned "good" survives).
export function mergeMetrics(siteDir, entries, cmd) {
  const m = readMetrics(siteDir);
  const today = new Date().toISOString().slice(0, 10);
  for (const [k, e] of Object.entries(entries || {})) {
    if (!e) continue;
    const clean = Object.fromEntries(Object.entries(e).filter(([kk, v]) => v !== undefined && v !== null && kk !== '_unset'));
    const prev = { ...(m.metrics[k] || {}) };
    // "_unset": fields the command now leaves to the engine (e.g. fixed anchors that a percentile replaces)
    for (const f of Array.isArray(e._unset) ? e._unset : []) delete prev[f];
    m.metrics[k] = { ...prev, ...clean, cmd: clean.cmd || cmd, as_of: clean.as_of || today };
  }
  m.uw = { cmd: 'metrics', updated_at: new Date().toISOString() };
  writeJSON(metricsPath(siteDir), m, { pretty: true });
  return m;
}

// Validate a metrics.json object. Returns [{ path, message, level }].
export function checkMetrics(m) {
  const out = [];
  if (!m || typeof m !== 'object' || !m.metrics || typeof m.metrics !== 'object') { out.push({ path: '$.metrics', message: 'metrics must be an object keyed by metric name', level: 'error' }); return out; }
  for (const [k, e] of Object.entries(m.metrics)) {
    const p = `$.metrics.${k}`;
    if (!e || typeof e !== 'object') { out.push({ path: p, message: 'entry must be an object', level: 'error' }); continue; }
    if (e.basis !== undefined && !BASIS.includes(e.basis)) out.push({ path: `${p}.basis`, message: `basis "${e.basis}" is not one of ${BASIS.slice(0, 10).join(', ')}`, level: 'error' });
    if (e.better !== undefined && !['higher', 'lower'].includes(e.better)) out.push({ path: `${p}.better`, message: 'better must be "higher" or "lower"', level: 'error' });
    if (e.confidence !== undefined && !['high', 'medium', 'low'].includes(e.confidence)) out.push({ path: `${p}.confidence`, message: 'confidence must be high, medium or low', level: 'error' });
    for (const n of ['good', 'bad', 'threshold', 'cap']) if (e[n] !== undefined && !Number.isFinite(e[n])) out.push({ path: `${p}.${n}`, message: `${n} must be a number`, level: 'error' });
    if (!e.basis) out.push({ path: `${p}.basis`, message: 'no basis: the engine cannot say how this number is known', level: 'warning' });
    if (!e.source) out.push({ path: `${p}.source`, message: 'no source', level: 'warning' });
  }
  return out;
}
