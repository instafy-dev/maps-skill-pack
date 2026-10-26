// map-pack engine: JSON-Schema subset validator (ENGINE-SPEC-v0.2 §9.2). Kit-owned file.
// Identical rules to scripts/lib/schema-lite.mjs validate()/applyDefaults() so the page, uw host and validate agree.
// Used for intent params (bind.js) and for sanitising untrusted records (records.js).

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const typeOk = (t, v) => { const a = typeOf(v); return t === a || (t === 'number' && a === 'integer'); };
const reCache = new Map();
const re = (p) => { let r = reCache.get(p); if (!r) { r = new RegExp(p); reCache.set(p, r); } return r; };
function formatOk(f, v) {
  if (typeof v !== 'string') return true;
  if (f === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
  if (f === 'date-time') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
  if (f === 'uri') { try { new URL(v); return true; } catch { return false; } }
  return true;
}
function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`only local $ref is supported (${ref})`);
  let s = root;
  for (const part of ref.slice(2).split('/')) s = s?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  if (s === undefined) throw new Error(`unresolved $ref ${ref}`);
  return s;
}

// Validate a value. Returns [{ path, message }] (empty = valid). Stops collecting after `max` errors.
export function validate(schema, value, { root = schema, path = '$', max = 50 } = {}) {
  const errors = [];
  const err = (p, m) => { if (errors.length < max) errors.push({ path: p, message: m }); };
  const v = (s, x, p) => {
    if (errors.length >= max) return;
    if (s === true || s === undefined) return;
    if (s === false) { err(p, 'not allowed'); return; }
    if (s.$ref) { v(resolveRef(root, s.$ref), x, p); return; }
    if (s.oneOf) {
      // discriminate on a "type" const when every branch has one: far clearer errors than "matched 0 of 3"
      const branches = s.oneOf.map((b) => (b.$ref ? resolveRef(root, b.$ref) : b));
      const consts = branches.map((b) => b?.properties?.type?.const);
      if (consts.every((c) => c !== undefined) && x && typeof x === 'object' && !Array.isArray(x)) {
        const i = consts.indexOf(x.type);
        if (i < 0) err(`${p}.type`, `must be one of ${consts.map((c) => JSON.stringify(c)).join(', ')}`);
        else v(branches[i], x, p);
      } else {
        const ok = branches.filter((b) => validate(b, x, { root, path: p, max: 1 }).length === 0).length;
        if (ok !== 1) err(p, `must match exactly one schema in oneOf (matched ${ok})`);
      }
      return;
    }
    if (s.type !== undefined) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some((t) => typeOk(t, x))) { err(p, `must be ${ts.join(' or ')} (got ${typeOf(x)})`); return; }
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(x)) err(p, `must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(x))) err(p, `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) err(p, 'must be a finite number');
      if (s.minimum !== undefined && x < s.minimum) err(p, `must be ≥ ${s.minimum}`);
      if (s.maximum !== undefined && x > s.maximum) err(p, `must be ≤ ${s.maximum}`);
    }
    if (typeof x === 'string') {
      const len = [...x].length;
      if (s.minLength !== undefined && len < s.minLength) err(p, `must be at least ${s.minLength} characters`);
      if (s.maxLength !== undefined && len > s.maxLength) err(p, `must be at most ${s.maxLength} characters`);
      if (s.pattern !== undefined && !re(s.pattern).test(x)) err(p, `must match ${s.pattern}`);
      if (s.format !== undefined && !formatOk(s.format, x)) err(p, `must be a valid ${s.format}`);
    }
    if (Array.isArray(x)) {
      if (s.minItems !== undefined && x.length < s.minItems) err(p, `must have at least ${s.minItems} items`);
      if (s.maxItems !== undefined && x.length > s.maxItems) err(p, `must have at most ${s.maxItems} items`);
      if (s.items) x.forEach((it, i) => v(s.items, it, `${p}[${i}]`));
    }
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const keys = Object.keys(x);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) err(p, `must have at most ${s.maxProperties} properties`);
      for (const r of s.required || []) if (x[r] === undefined) err(`${p}.${r}`, 'is required');
      const props = s.properties || {};
      for (const k of keys) {
        if (k in props) v(props[k], x[k], `${p}.${k}`);
        else if (s.additionalProperties === false) err(`${p}.${k}`, 'is not allowed (additionalProperties: false)');
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') v(s.additionalProperties, x[k], `${p}.${k}`);
      }
    }
  };
  v(schema, value, path);
  return errors;
}

// Fill "default" values of an object schema's properties (shallow, one level, like the engine's form).
export function applyDefaults(schema, value) {
  if (!schema || schema.type !== 'object' || !value || typeof value !== 'object') return value;
  const out = { ...value };
  for (const [k, s] of Object.entries(schema.properties || {})) if (out[k] === undefined && s && s.default !== undefined) out[k] = JSON.parse(JSON.stringify(s.default));
  return out;
}

export const fmtErrors = (errs, n = 3) => errs.slice(0, n).map((e) => `${e.path} ${e.message}`).join('; ') + (errs.length > n ? ` (+${errs.length - n} more)` : '');
