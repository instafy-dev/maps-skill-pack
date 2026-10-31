// "expect": the trip's stops with their nights, kept in map.config.json so every later `uw validate` checks the built
// map against them. A builder that loses a stop to a slow lookup cannot ship a map that quietly leaves it out (r10:
// every Taiwan team run dropped the two east-coast stops the traveller asked for, and validate still said the map was
// fine). Only stops: a turn that listed its own days and stays there ("Day 1: historic center", "Where to stay")
// renamed its pins to match, and those pins became the trip's stops, a day each.
// An entry is { name, nights }. `uw handoff --apply --route …` writes the route; `uw new --expect` and
// `uw validate --expect` take a list like "Taipei:3,Hualien:2,Taitung:0" (parseStops refuses anything else).
import { slugify, UsageError } from './util.mjs';

/** "Taipei:3, Hualien:2,Taitung" (or a JSON array) → [{ name, nights? }]. */
export function parseExpect(raw) {
  if (raw == null || raw === '') return [];
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (/^\s*\[/.test(String(raw))) {
    try { list = JSON.parse(raw); } catch (e) { throw new UsageError(`--expect: not a JSON array (${e.message})`); }
  } else list = String(raw).split(/[,;\n]/);
  const out = [];
  for (const x of list) {
    const e = normEntry(x);
    if (!e) continue;
    if (!out.some((o) => slugOf(o.name) === slugOf(e.name))) out.push(e);
  }
  return out;
}

function normEntry(x) {
  if (x && typeof x === 'object' && typeof x.name === 'string') {
    const name = x.name.trim();
    return name ? { name, ...(Number.isInteger(x.nights) && x.nights >= 0 ? { nights: x.nights } : {}) } : null;
  }
  const s = String(x ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(.+?)\s*:\s*(\d{1,2})$/);
  return m ? { name: m[1].trim(), nights: Number(m[2]) } : { name: s };
}

/** `--expect` of `uw new` and `uw validate`: the trip's stops with their nights ("Lisbon:3"), or a UsageError that
 *  names what is not one. Days come from `uw plan`, stays from `uw stay`. */
export function parseStops(raw, flag = '--expect') {
  const list = parseExpect(raw);
  const other = list.filter((e) => e.nights == null);
  if (other.length) {
    throw new UsageError(`${flag}: ${other.map((e) => JSON.stringify(e.name)).join(', ')} ${other.length === 1 ? 'is not a stop' : 'are not stops'} with nights. `
      + 'Name only the trip\'s stops with their nights ("Lisbon:3"). Days and stays come from uw plan and uw stay.');
  }
  return list;
}

/** The config's stops with nights (unknown shapes, and items without nights an older map listed, are not read). */
export const expectOf = (cfg) => parseExpect(Array.isArray(cfg?.expect) ? cfg.expect : []).filter((e) => e.nights != null);

/** Union, keeping the first list's order and its nights. */
export function mergeExpect(a, b) {
  const out = [...a];
  for (const e of b) {
    const i = out.findIndex((o) => slugOf(o.name) === slugOf(e.name));
    if (i < 0) out.push(e);
    else if (out[i].nights == null && e.nights != null) out[i] = { ...out[i], nights: e.nights };
  }
  return out;
}

const slugOf = (s) => slugify(s) || String(s || '').normalize('NFKC').trim().toLowerCase();
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Does this text name the item? As whole words ("Hualien Station" names Hualien; "Hualienne" does not). */
export function textNames(text, name) {
  const t = ` ${norm(text)} `, n = norm(name);
  if (!n) return false;
  // scripts without spaces between words (花蓮車站): a substring is a match
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(n)) return t.includes(n);
  return t.includes(` ${n} `);
}
const PROPS = ['name', 'name_en', 'osm_name_en', 'station_of', 'stop', 'id', 'title'];
/** Does a feature stand for the item: its id or stop is the item's slug (or starts with it: "hualien-hsr"), or one
 *  of its names names it. */
export function featureNames(props, name) {
  const s = slugOf(name);
  if (!props || !s) return false;
  for (const k of ['id', 'stop', 'station_of']) {
    const v = props[k];
    if (v == null) continue;
    const vs = slugOf(v);
    if (vs === s || vs.startsWith(`${s}-`)) return true;
  }
  return PROPS.some((k) => typeof props[k] === 'string' && textNames(props[k], name));
}

/** Which expected items the site leaves out. `featuresByLayer`: Map layer id → features. A plan (when there is one)
 *  must name the item too: a stop on the map that no day mentions is still missing from the itinerary.
 *  Resolves [{ name, nights?, on_map, in_plan }] for the items not covered. Pure; exported for the tests. */
export function uncovered(cfg, featuresByLayer, expect = expectOf(cfg)) {
  const all = [...featuresByLayer.values()].flat();
  const days = Array.isArray(cfg?.plan?.days) ? cfg.plan.days : null;
  const missingNames = new Set((Array.isArray(cfg?.missing) ? cfg.missing : []).map((m) => slugOf(m?.name)));
  const out = [];
  for (const e of expect) {
    const onMap = all.some((f) => featureNames(f?.properties, e.name));
    const inPlan = !days || !days.length ? null : days.some((d) => {
      const focus = d?.focus?.id != null && featureNames({ id: d.focus.id }, e.name);
      const words = [d?.title, d?.text, ...(Array.isArray(d?.items) ? d.items.map((it) => it?.text) : [])].filter((x) => typeof x === 'string').join(' \n ');
      return focus || textNames(words, e.name);
    });
    if (!onMap || inPlan === false) out.push({ ...e, on_map: onMap, in_plan: inPlan, not_found_yet: missingNames.has(slugOf(e.name)) });
  }
  return out;
}

/** "Hualien (2 nights), Taitung (2 nights)". */
export const describeItems = (items) => items.map((e) => `${e.name}${e.nights != null ? ` (${e.nights} night${e.nights === 1 ? '' : 's'})` : ''}`).join(', ');
