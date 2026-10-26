// map-pack engine: the question block — options, criteria, goodness, ranking, lenses, verdict and why lines
// (ENGINE-SPEC-v0.2 §1, §2, §4). Kit-owned file: sites should not edit it.
// Pure logic: no DOM, no MapLibre. engine.js feeds it features and records and renders what it returns.
import { LETTERS, LETTER_COLORS, BASIS, normBasis, fmtMetric, humanize, clamp, capFirst, word, noiseWord } from './util.js';

export const DEFAULT_BUDGET = { option: 5, support: 10, context: 80 };
export const KINDS = ['choose-one', 'find-area', 'plan-route', 'find-place', 'explore'];
const TIE_SCORE = 0.03;   // two options this close in score are called "close" in the persona line (never reordered)
// door vs walk area: one feel measured at the door (the 200 m square the windows face) and over the walk area can
// disagree (a main road at the door, quiet lanes behind). An option is "split" when it is at opposite ends of the
// options on the two (sole best on one, worst on the other; 3+ options), or when both are 0-1 estimates that differ
// by SPLIT_GAP or more ("very low" vs "high"). Its verdict and why lines then say both, never just one. Keys are
// tried in order (a criterion first); "most" = quietest for the first feel, liveliest for the second.
const SPLIT_GAP = 0.4;
const SPLITS = [
  { door: ['noise_night_db', 'calm_night'], area: ['calm_night_area', 'quiet_night_blocks', 'noise_night_db_area'], most: 'quietest', least: 'noisiest', more: 'quiet', less: 'noisy' },
  { door: ['lively_night'], area: ['lively_night_area', 'lively_night_blocks'], most: 'liveliest', least: 'quietest', more: 'lively', less: 'quiet' },
];
/** short basis tags for verdict facts; estimates say "est." in words, the rest a glyph with a title */
/** the word a verdict line adds for a fact's basis: only where it changes the meaning (no glyphs, no basis jargon) */
export const BASIS_TAG = { estimated: 'Estimate', brand: "maker's claim" };

/** Defaults for metric keys the scripts write (enrich / feel / areas / adapters), so labels, units and basis work
 *  without metrics.json. metrics.json, compare.metrics and the criterion's own keys override these. */
export function guessMetric(k) {
  if (/^nearest_.+_m$/.test(k)) return { unit: 'm', better: 'lower', basis: 'measured', scale: 'straight line' };
  if (/noise.*_db(_area)?$/.test(k)) return { unit: 'dB', better: 'lower', basis: 'estimated' };
  if (/^(calm_day|calm_night|green|amenities|green_frac)(_area)?$/.test(k)) return { format: 'pct', better: 'higher', basis: 'estimated' };
  if (/^(lively_day|lively_night)(_area)?$/.test(k)) return { format: 'pct', better: null, basis: 'estimated' };
  if (/_blocks$/.test(k)) return { unit: 'blocks', better: 'higher', basis: 'estimated' };
  if (/^(walk|ride)_min_/.test(k) || /_walk_min$/.test(k)) return { unit: 'min', better: 'lower', basis: 'routed' };
  if (/^(walk|ride)_km_/.test(k)) return { unit: 'km', better: 'lower', basis: 'routed' };
  if (/_\d+min$|_\d+m$|^n_/.test(k)) return { better: 'higher', basis: 'counted', count: true };
  if (/^tw_price_(min|max)$/.test(k)) return { unit: 'NT$', better: 'lower', basis: 'filed' };
  if (/^tw_rooms$/.test(k)) return { basis: 'registry' };
  if (/(^|_)(duration_min|distance_km|price)$/.test(k)) return { better: 'lower', ...(/_km$/.test(k) ? { unit: 'km', basis: 'routed' } : /_min$/.test(k) ? { unit: 'min', basis: 'routed' } : {}) };
  return {};
}
/** The layer a metric key is "about" (§3.5 mention patterns). */
export function mentionLayer(key, meta) {
  if (meta?.layer) return meta.layer;
  let m;
  if ((m = /^nearest_(.+)_m$/.exec(key))) return m[1];
  if ((m = /^(?:walk|ride)_(?:min|km)_(.+)$/.exec(key))) return m[1];
  if ((m = /^(.+)_\d+min$/.exec(key))) return m[1];
  if ((m = /^(.+)_\d+m$/.exec(key))) return m[1];
  return null;
}
/** Default anchors by unit / format (§1.4 table). */
function anchors(meta) {
  const lowerBetter = meta.better === 'lower';
  if (meta.format === 'pct') return lowerBetter ? { good: 0.3, bad: 0.7, threshold: 0.05 } : { good: 0.7, bad: 0.3, threshold: 0.05 };
  if (meta.unit === 'min') return { good: 3, bad: 15, threshold: 2 };
  if (meta.unit === 'm') return { good: 200, bad: 1200, threshold: 100 };
  if (meta.unit === 'dB') return { good: 55, bad: 70, threshold: 3 };
  if (meta.count || meta.unit === 'blocks') { const cap = meta.cap ?? 20; return { cap, good: cap, bad: 0, threshold: 3 }; }
  return {};
}

/** "Lore Hotel" → "Lore", "The Via Hotel Loft" → "Via Loft" (feature `short` wins). */
export function shortName(p) {
  if (typeof p.short === 'string' && p.short) return p.short;
  const en = typeof p.name_en === 'string' ? p.name_en.trim() : '';
  if (en) {
    let w = en.split(/\s+/);
    const drop = /^(hotel|the|taipei|inn)$/i;
    const kept = w.filter((x) => !drop.test(x));
    if (kept.length) w = kept;
    return w.slice(0, 2).join(' ');
  }
  return String(p.name || p.id || '');
}

export class Question {
  /**
   * @param {object} cfg config.question   @param {object} ctx { metrics, compare, features(layer), layerOf(id),
   *        claimValue(ref, attr), plan, areasLayers() }
   */
  constructor(cfg, ctx) {
    this.cfg = cfg || {};
    this.ctx = ctx;
    this.locale = ctx?.locale || 'en'; // map.config.json "locale": the words the verdict writes itself (util.js word)
    this.kind = KINDS.includes(this.cfg.kind) ? this.cfg.kind : 'choose-one';
    if (this.cfg.kind && !KINDS.includes(this.cfg.kind)) console.warn(`[map] question.kind "${this.cfg.kind}" unknown; using choose-one`);
    this.ask = typeof this.cfg.ask === 'string' ? this.cfg.ask : '';
    this.lenses = (Array.isArray(this.cfg.lenses) ? this.cfg.lenses : []).filter((l) => l && l.id).slice(0, 4);
    if ((this.cfg.lenses || []).length > 4) console.warn('[map] question.lenses: at most 4 are used');
    this.lens = null;
    this.user = {};
    const crit = (Array.isArray(this.cfg.criteria) ? this.cfg.criteria : []).filter((c) => c && typeof c.key === 'string');
    if (crit.length > 6) console.warn('[map] question.criteria: at most 6 are used');
    this.criteria = crit.slice(0, 6).map((c) => ({ ...c, weight: Math.max(0, Number(c.weight ?? 1) || 0) }));
    this.metaCache = new Map();
    this.opts = [];
  }

  get optionLayer() { return this.cfg.options?.layer || null; }
  get letters() { return this.kind === 'choose-one' || this.kind === 'find-place' ? this.cfg.options?.letters ?? 'given' : false; }
  budget() {
    const lens = this.lens && this.lenses.find((l) => l.id === this.lens);
    return { ...DEFAULT_BUDGET, ...(this.cfg.budget || {}), ...(lens?.budget || {}) };
  }

  /** merged metric meta: guess → metrics.json → compare.metrics → criterion overrides → anchors */
  meta(key) {
    if (this.metaCache.has(key)) return this.metaCache.get(key);
    const isClaim = key.startsWith('claim:');
    const base = isClaim ? key.slice(6) : key;
    const reg = this.ctx.metrics?.[key] || this.ctx.metrics?.[base] || {};
    const cmp = (this.ctx.compare?.metrics || []).find((m) => m.key === key) || {};
    const cr = this.criteria.find((c) => c.key === key) || {};
    const own = {};
    for (const k of ['label', 'short', 'unit', 'format', 'better', 'basis', 'confidence', 'source', 'scale', 'layer', 'id_key', 'good', 'bad', 'threshold', 'cap', 'as_of', 'note', 'partial', 'caveat'])
      if (cr[k] !== undefined) own[k] = cr[k];
    const m = { key, label: humanize(base), ...guessMetric(base), ...reg, ...cmp, ...own };
    if (cr.label) m.label = cr.label;
    if (m.better == null && (cr.key || m.good != null)) m.better = m.good != null && m.bad != null ? (m.good < m.bad ? 'lower' : 'higher') : 'higher';
    m.basis = normBasis(m.basis) || (isClaim ? 'registry' : null);
    if (!m.confidence && m.basis) m.confidence = BASIS[m.basis]?.conf || null;
    const a = anchors(m);
    // percentages the scripts estimate (calm, green…) rank against this map's own grid when there is one: the fixed
    // 0.7 / 0.3 anchors saturate in a dense city (every café "100% calm"), a percentile never does
    if (m.format === 'pct' && this.ctx.percentile?.(key, 0.5) != null) {
      m.pctShow = true;                            // shown as "top 5%" of this map's blocks
      if (m.good == null && m.bad == null) m.pctile = true;   // and ranked by it, unless the author set anchors
      if (!m.scale) m.scale = 'ranked against this map’s blocks';
    }
    for (const k of ['good', 'bad', 'threshold', 'cap']) if (m[k] == null && a[k] != null) m[k] = a[k];
    if (m.threshold == null) m.threshold = 0;
    this.metaCache.set(key, m);
    return m;
  }
  resetMeta() { this.metaCache.clear(); }

  /** Format a value of a metric for display ("3 min", "13 blocks", "plenty (20+)"). */
  fmt(key, x, { unit = true } = {}) {
    const m = this.meta(key);
    if (x == null || (typeof x === 'number' && !isFinite(x))) return '—';
    if (typeof x !== 'number') return String(x);
    if (m.cap != null && m.better !== 'lower' && x >= m.cap && (m.count || m.unit === 'blocks')) return word(this.locale, 'plenty', { n: m.cap });
    if (m.unit === 'NT$' || m.unit === 'TWD') return 'NT$' + Math.round(x).toLocaleString('en');
    // a decibel estimate is said in words ("some traffic noise"), never as a bare "65 dB"
    if (m.unit === 'dB' || m.format === 'db') return word(this.locale, noiseWord(x));
    // distance to an area's edge: 0 is "inside" (a café in the park), never "0 m"
    if (x === 0 && /^nearest_.+_m$/.test(key) && /edge/.test(m.scale || '')) return word(this.locale, 'inside');
    if (m.format === 'pct') {
      // never a bare "95%": a percentile of this map's blocks, else a word (estimates are scores, not shares)
      const p = m.pctShow ? this.ctx.percentile?.(key, x) : null;
      if (p != null) return p >= 0.5 ? word(this.locale, 'top', { n: Math.max(1, Math.round((1 - p) * 100)) }) : word(this.locale, 'bottom', { n: Math.max(1, Math.round(p * 100)) });
      if (m.basis === 'estimated') { const v = x <= 1.0001 ? x : x / 100; return word(this.locale, v >= 0.8 ? 'veryHigh' : v >= 0.6 ? 'high' : v >= 0.4 ? 'medium' : v >= 0.2 ? 'low' : 'veryLow'); }
      return Math.round(x <= 1.0001 ? x * 100 : x) + '%';
    }
    if (!unit) return fmtMetric(x, { ...m, unit: null });
    return fmtMetric(x, m);
  }

  /** value of a criterion key on an option: feature property, or claim:<attr> from records */
  value(o, key) {
    if (key.startsWith('claim:')) { const v = this.ctx.claimValue?.(o.ref, key.slice(6)); return typeof v === 'number' && isFinite(v) ? v : null; }
    const p = o.f?.properties || {};
    let v = p[key];
    if (v == null && p.mean && typeof p.mean === 'object') v = p.mean[key];
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /** Resolve the option list from the data (call again after records/features change). */
  resolve() {
    const kind = this.kind;
    let opts = [];
    if (kind === 'find-area') {
      for (const L of this.ctx.areasLayers?.() || []) for (const f of L.data.features) if (f.properties.verdict) opts.push({ layer: L.id, id: f.properties.id, f });
    } else if (kind === 'plan-route' || kind === 'explore') {
      opts = [];
    } else if (this.optionLayer) {
      const feats = this.ctx.features?.(this.optionLayer) || [];
      const byId = new Map(feats.map((f) => [String(f.properties.id), f]));
      const ids = Array.isArray(this.cfg.options?.ids) ? this.cfg.options.ids.map(String) : null;
      if (ids) { for (const id of ids) if (byId.has(id)) opts.push({ layer: this.optionLayer, id, f: byId.get(id) }); else console.warn(`[map] question.options.ids: no feature "${id}" in ${this.optionLayer}`); }
      else opts = feats.map((f) => ({ layer: this.optionLayer, id: String(f.properties.id), f }));
    }
    opts.forEach((o, i) => { o.i = i; o.ref = `${o.layer}:${o.id}`; });
    this.candidates = opts;
    if (kind === 'find-place') {
      const top = clamp(Number(this.cfg.options?.top) || 5, 1, 5);
      this.opts = this.rankList(opts).slice(0, top).map((r) => r.o);
      this.opts.forEach((o, i) => { o.i = i; });
    } else this.opts = kind === 'choose-one' ? opts.slice(0, 5) : opts;
    if (kind === 'choose-one' && opts.length > 5) console.warn('[map] question: choose-one uses the first 5 options');
    this.assignLetters();
    return this.opts;
  }
  assignLetters() {
    const mode = this.letters;
    const order = mode === 'rank' ? this.rankList(this.opts).map((r) => r.o) : this.opts;
    for (const o of this.opts) { o.letter = null; o.color = null; }
    if (mode === false) return;
    order.forEach((o, i) => { if (i < LETTERS.length) { o.letter = LETTERS[i]; o.color = LETTER_COLORS[o.letter]; } });
  }
  option(ref) { return this.opts.find((o) => o.ref === ref) || null; }
  optionById(layer, id) { return this.opts.find((o) => o.layer === layer && o.id === String(id)) || null; }
  isOption(layer, id) { return !!this.optionById(layer, id); }

  // ----- weights -----
  baseWeights() { return Object.fromEntries(this.criteria.map((c) => [c.key, c.weight])); }
  lensWeights(lensId) {
    const w = this.baseWeights();
    const lens = lensId && this.lenses.find((l) => l.id === lensId);
    if (lens?.weights) for (const [k, v] of Object.entries(lens.weights)) if (k in w) w[k] = Math.max(0, Number(v) || 0);
    return w;
  }
  weights() {
    const w = this.lensWeights(this.lens);
    for (const [k, v] of Object.entries(this.user)) if (k in w) w[k] = clamp(Number(v) || 0, 0, 3);
    return w;
  }
  setUserWeights(obj) { this.user = {}; for (const [k, v] of Object.entries(obj || {})) if (this.criteria.some((c) => c.key === k)) this.user[k] = clamp(Math.round(Number(v) || 0), 0, 3); }

  // ----- goodness -----
  /** goodness of an option on criterion key (0..1) + confidence; missing value = 0.5, low */
  g(o, key, pool = this.opts) {
    const m = this.meta(key), x = this.value(o, key);
    if (x == null) return { g: 0.5, conf: 'low', x: null };
    let g;
    const pc = m.pctile ? this.ctx.percentile?.(key, x) : null;
    if (pc != null) g = m.better === 'lower' ? 1 - pc : pc;
    else if (m.good != null && m.bad != null && m.good !== m.bad) g = clamp((x - m.bad) / (m.good - m.bad), 0, 1);
    else if (m.cap != null && m.better !== 'lower') g = clamp(x / m.cap, 0, 1);
    else {
      const vals = pool.map((p) => this.value(p, key)).filter((v) => v != null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      g = hi > lo ? (x - lo) / (hi - lo) : 0.5;
      if (m.better === 'lower') g = 1 - g;
    }
    return { g, conf: m.confidence || 'medium', x };
  }
  /** options tied with the best value on a criterion (|Δ| < threshold, or both past the cap) */
  leaders(key, pool = this.opts) {
    const m = this.meta(key);
    const vals = pool.map((o) => ({ o, x: this.value(o, key) })).filter((v) => v.x != null);
    if (!vals.length) return [];
    const lower = m.better === 'lower';
    const best = vals.reduce((a, b) => (lower ? (b.x < a.x ? b : a) : (b.x > a.x ? b : a)));
    const capped = (x) => m.cap != null && !lower && x >= m.cap;
    return vals.filter((v) => Math.abs(v.x - best.x) < (m.threshold || 1e-9) || v === best || (capped(v.x) && capped(best.x))).map((v) => v.o);
  }
  soleLeader(o, key) { const L = this.leaders(key); return L.length === 1 && L[0] === o && this.opts.length > 1; }
  isLast(o, key) {
    const m = this.meta(key);
    const vals = this.opts.map((p) => ({ p, x: this.value(p, key) })).filter((v) => v.x != null);
    if (vals.length < 2) return false;
    const x = this.value(o, key); if (x == null) return false;
    const lower = m.better === 'lower';
    const worst = vals.reduce((a, b) => (lower ? (b.x > a.x ? b : a) : (b.x < a.x ? b : a)));
    if (worst.p !== o) return false;
    const others = vals.filter((v) => v.p !== o).map((v) => v.x);
    const next = lower ? Math.max(...others) : Math.min(...others);
    return Math.abs(x - next) > (m.threshold || 0);
  }

  // ----- ranking -----
  rankList(pool = this.opts, weights = this.weights()) {
    const keys = this.criteria.map((c) => c.key).filter((k) => (weights[k] || 0) > 0);
    const W = keys.reduce((s, k) => s + weights[k], 0);
    const rows = pool.map((o) => {
      const g = {};
      let s = 0;
      for (const c of this.criteria) g[c.key] = this.g(o, c.key, pool).g;
      for (const k of keys) s += weights[k] * g[k];
      return { o, score: W > 0 ? s / W : 0, g };
    });
    // strictly by score (a total order: the lead line is always the top score); only exact ties keep the given order.
    // Near-ties are said in words instead (nearTie), never by reordering.
    const q = (x) => Math.round(x * 1e6);
    return rows.sort((a, b) => q(b.score) - q(a.score) || a.o.i - b.o.i);
  }
  /** the top two when they are within TIE_SCORE of each other: [o1, o2] or null */
  nearTie(weights = this.weights()) {
    const r = this.rankList(this.opts, weights);
    return r.length > 1 && r[0].score - r[1].score < TIE_SCORE ? [r[0].o, r[1].o] : null;
  }
  rank() {
    return this.rankList().map((r, i) => ({ ref: r.o.ref, layer: r.o.layer, id: r.o.id, letter: r.o.letter, rank: i + 1, score: Math.round(r.score * 1000) / 1000, g: r.g }));
  }
  /** #1 option under a lens's weights */
  topFor(lensId) { const r = this.rankList(this.opts, this.lensWeights(lensId)); return r[0]?.o || null; }

  // ----- phrases -----
  crit(key) { return this.criteria.find((c) => c.key === key) || { key, weight: 0 }; }
  /** a criterion's label; an older "(est.)" reads "(estimate)" (the trust word pages use) */
  label(key) { const l = this.crit(key).label || this.meta(key).label; return typeof l === 'string' ? l.replace(/\(est\.\)/g, '(estimate)') : l; }
  leadPhrase(key) { return this.crit(key).phrase?.lead || 'best ' + String(this.label(key)).toLowerCase(); }
  valuePhrase(key, x) {
    const m = this.meta(key);
    const zero = this.crit(key).phrase?.zero;
    if (x === 0 && zero) return zero;
    const tpl = this.crit(key).phrase?.value || (m.format === 'pct' ? '{label}: {value}' : '{label} {value}');
    return this.tpl(key, tpl, x);
  }
  /** the phrase for an option that is the worst of the options on a criterion ("loudest door at night") */
  worstPhrase(key, x) {
    const zero = this.crit(key).phrase?.zero;
    if (x === 0 && zero) return zero;
    const tpl = this.crit(key).phrase?.worst;
    return tpl ? this.tpl(key, tpl, x) : this.valuePhrase(key, x);
  }
  tpl(key, tpl, x) {
    const m = this.meta(key);
    // "{value} quiet blocks": the template already names the unit, so don't print it twice
    const unitWord = m.unit && tpl.replace('{value}', '').toLowerCase().includes(String(m.unit).toLowerCase());
    const lab = String(this.label(key));
    return tpl.replace('{value}', this.fmt(key, x, { unit: !unitWord })).replace('{n}', this.fmt(key, x, { unit: false }))
      .replace('{label}', tpl.startsWith('{label}') ? lab : lab.toLowerCase()).trim();
  }
  isEst(key) { return this.meta(key).basis === 'estimated'; }
  /** the caveat of a metric made from incomplete data ("MRT data partial"), else null. Such a metric is said as a value,
   *  never as "shortest" / "longest": the option it would crown may only look best because data is missing. */
  partialOf(key) {
    const m = this.meta(key);
    if (!m.partial) return null;
    return typeof m.caveat === 'string' && m.caveat ? m.caveat : `${String(m.short || this.label(key))} data partial`;
  }
  /** caveats for everything the ranking weighs now (for the persona line / a head chip) */
  caveats(weights = this.weights()) {
    return [...new Set(this.criteria.filter((c) => (weights[c.key] || 0) > 0).map((c) => this.partialOf(c.key)).filter(Boolean))];
  }
  basisOf(key) { return this.meta(key).basis || null; }
  /** one fact of a verdict line: its own basis travels with it (a routed minute is never called "est.") */
  fact(key, text, extra = {}) { return { key, text, basis: this.basisOf(key), ...extra }; }
  static factText(f) { return f.text + (f.basis === 'estimated' ? ' (estimate)' : ''); }
  lineText(short, facts, caveats = []) { return [short, ...facts.map((f) => Question.factText(f)), Question.caveatText(caveats)].filter(Boolean).join(' · '); }
  /** one plain caveat for a line: "MRT data partial", "MRT, Cafés data partial" (words, no warning glyph) */
  static caveatText(caveats = []) {
    if (!caveats.length) return '';
    const heads = caveats.map((c) => String(c).replace(/ data partial$/, ''));
    return caveats.every((c) => / data partial$/.test(c)) ? `${heads.join(', ')} data partial` : caveats.join(' · ');
  }

  // ----- verdict (§2.2) -----
  /** a one-line heading above the lines when the kind needs one ("Top 5 of 445 cafés", the route summary) */
  verdictHead() {
    if (this.kind === 'find-place') {
      const all = this.candidates?.length || 0;
      const noun = this.cfg.options?.noun || this.ctx.layerTitle?.(this.optionLayer) || 'places';
      return all > this.opts.length ? { text: `Top ${this.opts.length} of ${all} ${String(noun).toLowerCase()}`, cites: ['options.top'] } : null;
    }
    if (this.kind === 'plan-route') return this.ctx.planSummary?.() || null;
    // find-area with a walk in the plan: the walk is part of the answer ("🚶 3 stops · 2.1 km · 31 min, routed")
    if (this.kind === 'find-area') return this.ctx.routeSummary?.() || null;
    return null;
  }
  verdictLines() {
    const vcfg = this.ctx.verdict || {};
    const mode = vcfg.mode || 'auto';
    const facts = clamp(Number(vcfg.facts) || 2, 1, 3);
    const authored = (Array.isArray(vcfg.lines) ? vcfg.lines : []).filter((l) => l && typeof l.text === 'string');
    const lensOk = (l) => !l.lens || l.lens === this.lens;
    if (mode === 'authored' || this.kind === 'explore') {
      return authored.filter(lensOk).slice(0, 5).map((l) => {
        const o = l.ref ? this.option(l.ref) : null;
        return { ref: l.ref || null, letter: o?.letter || null, color: o?.color || null, text: l.text, cites: Array.isArray(l.cites) ? l.cites : [], authored: true, short: o ? shortName(o.f.properties) : '' };
      });
    }
    if (this.kind === 'plan-route') return this.planLines();
    const pinned = new Map(authored.filter((l) => l.pin && l.ref && lensOk(l)).map((l) => [l.ref, l]));
    const ranked = this.rankList();
    if (this.kind === 'find-area') return ranked.slice(0, 3).map((r) => this.areaLine(r));
    const lines = [];
    for (const r of ranked.slice(0, 5)) {
      const pin = pinned.get(r.o.ref);
      if (pin) { lines.push({ ref: r.o.ref, letter: r.o.letter, color: r.o.color, short: shortName(r.o.f.properties), text: pin.text, cites: pin.cites || [], authored: true }); continue; }
      lines.push(this.optionLine(r, facts));
    }
    return lines;
  }
  /** find-area: "Green and leafy · Da'an Forest Park" + what else it offers (its own lens is already in the verdict) */
  areaLine(r) {
    const o = r.o, p = o.f.properties;
    const own = p.field || ({ quiet_night: 'calm_night', quiet_day: 'calm_day', lively_night: 'lively_night', lively_day: 'lively_day', green: 'green', amenities: 'amenities' })[p.lens] || null;
    const have = this.criteria.filter((c) => this.value(o, c.key) != null);
    // what the area offers beyond its own verdict ("Green and leafy" + "also calm by day: top 8%"); its own number
    // only when nothing else stands out. Always "label: value" (a bare "top 2%" says nothing).
    // "stands out" = top 20% of this map's blocks when there is a grid to rank against, else goodness ≥ 0.75
    const strong = (c) => { const p = this.meta(c.key).pctShow ? this.ctx.percentile?.(c.key, this.value(o, c.key)) : null; return p != null ? p >= 0.8 : r.g[c.key] >= 0.75; };
    const other = have.filter((c) => c.key !== own && strong(c)).sort((a, b) => r.g[b.key] - r.g[a.key])[0];
    const mine = have.find((c) => c.key === own) || have.sort((a, b) => r.g[b.key] - r.g[a.key])[0];
    const fs = [];
    const lv = (key) => this.tpl(key, '{label}: {value}', this.value(o, key));
    if (other) fs.push(this.fact(other.key, 'also ' + lv(other.key).replace(/^\w/, (c) => c.toLowerCase())));
    // its own verdict already names the lens: just how far up this map it ranks
    else if (mine) fs.push(this.fact(mine.key, mine.key === own && this.meta(mine.key).pctShow ? `${this.fmt(mine.key, this.value(o, mine.key))} of this map` : lv(mine.key)));
    const short = p.name || '';
    return { ref: o.ref, letter: null, color: null, short, verdict: p.verdict || '', facts: fs, phrases: fs.map((f) => Question.factText(f)),
      text: [p.verdict, this.lineText(short, fs)].filter(Boolean).join(' · '), cites: fs.map((f) => f.key) };
  }
  optionLine(r, nFacts) {
    const o = r.o, w = this.weights();
    const crit = this.criteria.filter((c) => this.value(o, c.key) != null);
    const weighted = crit.filter((c) => (w[c.key] || 0) > 0).sort((a, b) => w[b.key] - w[a.key] || r.g[b.key] - r.g[a.key]);
    const out = [], used = new Set();
    const push = (key, kind) => { if (!used.has(key)) { used.add(key); out.push({ key, kind }); } };
    // 1. where this option leads on what you weighted (heaviest first)
    for (const c of weighted) if (this.soleLeader(o, c.key)) push(c.key, 'lead');
    // 2. other weighted criteria it does well on
    for (const c of weighted) if (!used.has(c.key) && r.g[c.key] >= 0.6) push(c.key, 'value');
    // 3. what else stands out (weight 0): only after everything you weighted
    for (const c of crit) if (!((w[c.key] || 0) > 0) && this.soleLeader(o, c.key)) push(c.key, 'lead');
    // the worst of the options on something you weighted heavily (≥ 2, or the heaviest) is said, not hidden
    const top = weighted[0];
    let caveat = weighted.find((c) => !used.has(c.key) && (w[c.key] >= 2 || c === top) && this.isLast(o, c.key))?.key || null;
    // 4. no caveat and room left: where it stands on the heaviest criterion, so a lens never leaves its own topic out
    if (!caveat && top && !used.has(top.key) && out.length < nFacts) push(top.key, 'value');
    // a watched fact (night market 260 m away in its hours) is the caveat of the lenses it belongs to
    const wt = this.watchFor(o).find((x) => !x.lenses || x.lenses.includes(this.lens));
    // a caveat takes the place of the second fact: two lines on a phone, never a third
    let picked = out.slice(0, wt || caveat ? Math.max(1, nFacts - 1) : nFacts);
    if (!picked.length && !caveat && crit.length) picked = [{ key: crit[0].key, kind: 'value' }];
    const fs = picked.map((x, i) => this.fact(x.key, x.kind === 'lead' && i === 0 && !this.partialOf(x.key) ? this.leadPhrase(x.key) : this.valuePhrase(x.key, this.value(o, x.key)), this.partialOf(x.key) ? { partial: this.partialOf(x.key) } : {}));
    if (wt) fs.push(this.fact(wt.key, (fs.length ? 'but ' : '') + wt.text, { caveat: true, basis: wt.basis, also: wt.hoursKey ? [wt.hoursKey] : [] }));
    else if (caveat) {
      // partial data: the plain value ("but 13 min walk to the MRT"), never "longest" (a missing station may be closer)
      const pc = this.partialOf(caveat);
      const t = pc ? this.valuePhrase(caveat, this.value(o, caveat)) : this.worstPhrase(caveat, this.value(o, caveat));
      fs.push(this.fact(caveat, fs.length ? 'but ' + t.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) : t, { caveat: true, ...(pc ? { partial: pc } : {}) }));
    }
    // door and walk area disagree: say both in one fact, in place of the one it would have said (whatever the lens);
    // else added when there is room, or when this lens weighs either (in place of the last fact but a watched one).
    // A lens that weighs neither on a full line leaves it to the why card: a third fact gets cut off on a phone (S17).
    const sp = this.splitFor(o);
    if (sp) {
      const f = this.fact(sp.door, sp.text, { also: [sp.area], split: sp.side, ...(sp.side < 0 ? { caveat: true } : {}) });
      // every door or walk-area fact on this feel ("but loudest door at night") is said by the split fact
      const same = new Set([...sp.feel.door, ...sp.feel.area]);
      let j = fs.findIndex((x) => same.has(x.key));
      if (j < 0 && fs.length >= nFacts && ((w[sp.door] || 0) > 0 || (w[sp.area] || 0) > 0)) j = fs.findLastIndex((x, k) => k > 0 && x.key !== wt?.key);
      if (j >= 0) fs[j] = f; else if (fs.length < nFacts) fs.push(f);
      for (let k = fs.length - 1; k >= 0; k--) if (fs[k] !== f && same.has(fs[k].key)) fs.splice(k, 1);
      // a merged pair frees a slot: the next thing it does well goes before the split ("shortest walk to the MRT · …")
      for (const x of out) {
        if (fs.length >= nFacts) break;
        if (same.has(x.key) || fs.some((y) => y.key === x.key)) continue;
        const first = fs.indexOf(f) === 0;
        fs.splice(fs.indexOf(f), 0, this.fact(x.key, x.kind === 'lead' && first && !this.partialOf(x.key) ? this.leadPhrase(x.key) : this.valuePhrase(x.key, this.value(o, x.key)), this.partialOf(x.key) ? { partial: this.partialOf(x.key) } : {}));
      }
    }
    // one "but" per line: a second caveat ("· but night market 262 m away" after "…, but quietest walk area") is said
    // as a plain fact, so the line reads as one thought
    let buts = 0;
    for (let k = 0; k < fs.length; k++) {
      const n = (String(fs[k].text).match(/\bbut\b/g) || []).length;
      if (buts && /^but /.test(fs[k].text)) fs[k] = { ...fs[k], text: fs[k].text.replace(/^but /, '') };
      buts += n;
    }
    const short = shortName(o.f.properties);
    const caveats = [...new Set(fs.map((f) => f.partial).filter(Boolean))];
    return { ref: o.ref, letter: o.letter, color: o.color, short, facts: fs, caveats, phrases: fs.map((f) => Question.factText(f)), text: this.lineText(short, fs, caveats), cites: fs.flatMap((f) => [f.key, ...(f.also || [])]) };
  }
  planLines() {
    const days = this.ctx.plan?.days || [];
    return days.map((d, i) => {
      // the "D1" chip already says the day: drop a leading "Day 1 ·" from the title
      const title = String(d.title || `Day ${i + 1}`).replace(/^(day\s*)?\d+\s*[·:.-]\s*/i, '') || `Day ${i + 1}`;
      return { ref: null, day: i, letter: null, dayChip: `D${i + 1}`, color: null, text: title, cites: ['plan.days'], authored: true, short: '' };
    });
  }
  /** Why an option is the pick under these weights, in plain words: the heaviest weighted thing it is best at
   *  ("closest MRT, 3 min"); when another option ties it there, the tie is said and so is the next thing that sets it
   *  apart, with the tied option's value ("quietest door at night, tied with C, and 4 quiet blocks nearby (C 0)").
   *  { text, estimate } or null. Never a bare number like dB, never a lone "-est" on a tied value. */
  reasonFor(o, weights = this.weights()) {
    if (!o || this.opts.length < 2) return null;
    const keys = this.criteria.filter((c) => (weights[c.key] || 0) > 0 && this.value(o, c.key) != null)
      .sort((a, b) => weights[b.key] - weights[a.key]); // stable: equal weights keep the config's order
    if (!keys.length) return null;
    const facts = [];
    const lead = keys.find((c) => !this.partialOf(c.key) && this.leaders(c.key).includes(o));
    if (lead) {
      const tied = this.leaders(lead.key).filter((p) => p !== o);
      const name = (p) => p.letter || shortName(p.f.properties);
      const first = this.reasonFact(lead.key, o, true);
      if (tied.length) first.text += `, tied with ${tied.map(name).join(' and ')}`;
      facts.push(first);
      const sep = tied.length ? keys.find((c) => c !== lead && tied.every((p) => this.beats(o, p, c.key))) : null;
      if (sep) {
        const f = this.reasonFact(sep.key, o, false);
        // "(C 0)" never breaks between the letter and its value
        f.text += ` (${tied.map((p) => `${name(p)}\u00a0${this.fmt(sep.key, this.value(p, sep.key), { unit: false })}`).join(' · ')})`;
        facts.push(f);
      }
    } else {
      // best by the mix, first on nothing: what it does best on what is weighed
      const r = this.rankList(this.opts, weights).find((x) => x.o === o);
      const best = keys.slice().sort((a, b) => weights[b.key] * r.g[b.key] - weights[a.key] * r.g[a.key])[0];
      facts.push(this.reasonFact(best.key, o, false));
    }
    return { text: facts.map((f) => f.text).join(facts[0].text.includes(', tied with ') ? ', and ' : ' and '), estimate: facts.some((f) => f.estimate), cites: facts.map((f) => f.key) };
  }
  /** o is better than p on key by more than the metric's threshold */
  beats(o, p, key) {
    const a = this.value(o, key), b = this.value(p, key), m = this.meta(key);
    if (a == null) return false;
    if (b == null) return true;
    return (m.better === 'lower' ? b - a : a - b) > (m.threshold || 0);
  }
  reasonFact(key, o, lead) {
    const m = this.meta(key), x = this.value(o, key);
    // a lead says the comparison and, for a plain number people know (minutes, metres, km), the number too
    const plain = m.format !== 'pct' && /^(min|m|km)$/.test(m.unit || m.format || '') && m.basis !== 'estimated';
    const text = lead ? this.leadPhrase(key) + (plain ? ', ' + this.fmt(key, x) : '') : this.valuePhrase(key, x);
    return { key, text, estimate: m.basis === 'estimated' };
  }
  /** "Light sleepers: A (quietest door at night and 4 quiet blocks nearby, estimate)": each pick with its reason */
  static pickText(label, name, reason) {
    return `${label}: ${name}${reason ? ` (${reason.text}${reason.estimate ? ', estimate' : ''})` : ''}`;
  }
  personaLine() {
    if (this.kind !== 'choose-one' && this.kind !== 'find-place') return null;
    if (this.opts.length < 2) return null;
    const name = (o) => o.letter || shortName(o.f.properties);
    const tie = this.nearTie();
    const close = tie ? ` · ${word(this.locale, 'close', { a: name(tie[0]), b: name(tie[1]) })}` : '';
    const ps = this.kind === 'choose-one' ? this.lenses.filter((l) => l.persona) : [];
    if (ps.length >= 2) {
      const picks = ps.map((l) => ({ l, o: this.topFor(l.id) })).filter((x) => x.o)
        .map((x) => ({ ...x, reason: this.reasonFor(x.o, this.lensWeights(x.l.id)) }));
      const distinct = new Set(picks.map((x) => x.o.ref));
      if (distinct.size >= 2) {
        return { text: picks.map((x) => Question.pickText(x.l.persona, name(x.o), x.reason)).join(' · ') + close, close: close ? close.slice(3) : '',
          picks: picks.map((x) => ({ lens: x.l.id, ref: x.o.ref, label: x.l.persona, name: name(x.o), letter: x.o.letter || null, color: x.o.color || null, reason: x.reason?.text || '', estimate: !!x.reason?.estimate, cites: x.reason?.cites || [] })) };
      }
    }
    if (this.ctx.verdict?.persona === false) return close ? { text: close.slice(3), picks: [] } : null;
    const ranked = this.rankList();
    const top = ranked[0]?.o;
    if (this.kind === 'find-place') return close ? { text: close.slice(3), picks: [] } : null;
    // nothing measured so far separates them: never name a "best" (the letters are then just the given order)
    if (ranked.length > 1 && ranked[0].score - ranked[ranked.length - 1].score < TIE_SCORE) return { text: word(this.locale, 'tie'), picks: [] };
    const cav = this.caveats();
    return top ? { text: `${word(this.locale, 'best', { name: name(top) })}${close}${cav.length ? ` · ${word(this.locale, 'soFar')} (${cav.join(', ')})` : ''}`, picks: [{ lens: null, ref: top.ref }], caveats: cav } : null;
  }

  /** question.watch: [{ key: "nearest_nightmarkets_m", within: 400, label: "Night market", hours: "nearest_nightmarkets_hours",
   *  lenses: ["sleep"] }] → the facts that apply to this option ({ key, text, hours, basis, lenses }) */
  watchFor(o) {
    const out = [];
    for (const w of Array.isArray(this.cfg.watch) ? this.cfg.watch : []) {
      if (!w || typeof w.key !== 'string') continue;
      const x = this.value(o, w.key);
      if (x == null || x > (Number(w.within) || 400)) continue;
      const hours = typeof w.hours === 'string' ? o.f.properties[w.hours] : null;
      // the nearest one's own kind when it has one (a day market is not a "night market")
      const kind = o.f.properties[String(w.key).replace(/_m$/, '_kind')];
      const lab = String((typeof kind === 'string' && kind ? humanize(kind) : null) || w.label || this.meta(w.key).label || w.key);
      out.push({ key: w.key, x, lenses: Array.isArray(w.lenses) ? w.lenses : null, basis: this.meta(w.key).basis || 'measured',
        text: `${lab.toLowerCase()} ${this.fmt(w.key, x)} away${typeof hours === 'string' && hours ? ` (${hours})` : ''}`, label: lab, hours: typeof hours === 'string' ? hours : null, hoursKey: typeof w.hours === 'string' ? w.hours : null });
    }
    return out;
  }

  /** door vs walk area on one feel (SPLITS): { door, area, side, text } when this option's two disagree, else null.
   *  side -1 = the door is the worse of the two ("noisiest door at night, but quietest walk area"), +1 the better. */
  splitFor(o) {
    if (this.opts.length < 2) return null;
    for (const S of SPLITS) {
      const have = (k) => this.value(o, k) != null && this.opts.filter((p) => this.value(p, k) != null).length >= 2;
      const pick = (keys) => keys.find((k) => this.criteria.some((c) => c.key === k) && have(k)) || keys.find(have);
      const door = pick(S.door), area = pick(S.area);
      if (!door || !area) continue;
      const end = (k) => this.opts.length < 3 ? 0 : this.soleLeader(o, k) ? 1 : this.isLast(o, k) ? -1 : 0;
      const ed = end(door);
      let side = ed && end(area) === -ed ? ed : 0;
      const ends = !!side;
      const pct = (k) => this.meta(k).format === 'pct';
      if (!side && pct(door) && pct(area)) { const gap = this.value(o, door) - this.value(o, area); if (Math.abs(gap) >= SPLIT_GAP) side = gap > 0 ? 1 : -1; }
      if (!side) continue;
      const [d, a] = side < 0 ? (ends ? [S.least, S.most] : [S.less, S.more]) : (ends ? [S.most, S.least] : [S.more, S.less]);
      return { door, area, side, feel: S, text: `${d} door at night, but ${a} walk area` };
    }
    return null;
  }

  // ----- why lines (§4) -----
  whyValue(o, key) {
    const x = this.value(o, key);
    const own = this.fmt(key, x);
    if (this.opts.length > 1 && this.opts.length <= 3) {
      const others = this.opts.filter((p) => p !== o).map((p) => `${p.letter || shortName(p.f.properties)} ${this.fmt(key, this.value(p, key), { unit: false })}`);
      return `${own} (${others.join(' · ')})`;
    }
    return own;
  }
  why(o, authored = [], editorial = []) {
    const w = this.weights();
    const rows = this.criteria.map((c) => ({ c, key: c.key, ...this.g(o, c.key), w: w[c.key] || 0, sole: this.soleLeader(o, c.key), last: this.isLast(o, c.key) }));
    const lines = [];
    const metaLine = (key, mark, text) => {
      const m = this.meta(key);
      return { mark, text, value: this.whyValue(o, key), basis: m.basis || null, confidence: m.confidence || null, source: m.source || null, scale: m.scale || null, cites: [key], ...(this.partialOf(key) ? { partial: this.partialOf(key) } : {}) };
    };
    for (const a of authored.slice(0, 3)) lines.push({ mark: a.mark || 'neutral', text: String(a.text || '').slice(0, 60), value: a.value ? String(a.value) : '', basis: normBasis(a.basis) || (a.basis === 'editorial' ? 'editorial' : null), confidence: a.confidence || null, cites: Array.isArray(a.cites) ? a.cites : [], authored: true });
    const checks = rows.filter((r) => r.x != null && (r.g >= 0.6 || r.sole)).sort((a, b) => b.w * b.g - a.w * a.g || b.g - a.g);
    const nCheck = Math.max(0, 2 - lines.filter((l) => l.mark === 'check').length);
    const shownChecks = checks.slice(0, nCheck);
    for (const r of shownChecks) lines.push(metaLine(r.key, 'check', capFirst(r.sole && !this.partialOf(r.key) ? this.leadPhrase(r.key) : this.label(r.key))));
    const crosses = rows.filter((r) => r.x != null && r.w > 0 && (r.g <= 0.4 || r.last) && !shownChecks.includes(r)).sort((a, b) => b.w * (1 - b.g) - a.w * (1 - a.g));
    const cross = crosses[0] || null;
    if (cross && !lines.some((l) => l.mark === 'cross')) lines.push(metaLine(cross.key, 'cross', capFirst(cross.c.phrase?.cross || this.label(cross.key))));
    // watched surroundings: a cross line with the number, the hours and the basis, whatever the lens
    // door vs walk area: both values on one line, so a ✗ door next to a ✓ walk area does not read as a contradiction
    const sp = this.splitFor(o);
    if (sp) lines.push({ mark: 'neutral', text: capFirst(sp.text), value: `door ${this.fmt(sp.door, this.value(o, sp.door))} · walk area ${this.fmt(sp.area, this.value(o, sp.area))}`,
      basis: this.basisOf(sp.door), confidence: this.meta(sp.door).confidence || null, cites: [sp.door, sp.area], split: sp.side });
    for (const wt of this.watchFor(o)) lines.push({ mark: 'cross', text: capFirst(`${wt.label} ${this.fmt(wt.key, wt.x)} away`), value: wt.hours || '', basis: wt.basis, confidence: this.meta(wt.key).confidence || null, cites: [wt.key], watch: true });
    for (const e of editorial) {
      const t = String(e.text || '').trim();
      if (!t) continue;
      const lc = t.toLowerCase().replace(/\s*\(est\.\)\s*/g, '');
      if (lines.some((l) => lc.includes(String(l.text).toLowerCase()) || String(l.text).toLowerCase().includes(lc))) continue;
      lines.push({ mark: 'neutral', text: t.slice(0, 80), value: '', basis: 'editorial', confidence: null, cites: [], emoji: e.emoji || null, editorial: true });
    }
    // trade-off sentence: explains how the best and the worst line relate, instead of repeating the ✗ line
    let tradeoff;
    const basisWord = (key) => (this.meta(key).basis === 'estimated' ? 'estimate' : BASIS[this.meta(key).basis]?.chip || '');
    if (cross) {
      const pc = this.partialOf(cross.key);
      const worst = cross.last && !pc ? this.worstPhrase(cross.key, cross.x) : `${String(this.label(cross.key)).toLowerCase()} ${this.fmt(cross.key, cross.x)}`;
      const good = shownChecks.find((r) => r.w > 0) || shownChecks[0];
      const goodTxt = good ? (good.sole && !this.partialOf(good.key) ? this.leadPhrase(good.key) : String(this.label(good.key)).toLowerCase()) : null;
      const bw = basisWord(cross.key);
      tradeoff = `Trade-off: ${goodTxt ? goodTxt + ', but ' : ''}${worst}${bw ? ` (${bw})` : ''}${cross.last && !pc && this.opts.length > 2 ? `, the worst of the ${this.opts.length}` : ''}${pc ? ` (${pc})` : ''}.`;
    } else {
      const weighted = rows.filter((r) => r.x != null && r.w > 0);
      if (weighted.length && weighted.every((r) => r.g >= 0.6)) tradeoff = 'No clear trade-off among what you weighted.';
      else {
        const low = weighted.sort((a, b) => a.g - b.g)[0];
        if (low) tradeoff = `Trade-off: nothing sharp, but ${String(this.label(low.key)).toLowerCase()} is middling (${this.fmt(low.key, low.x)}${basisWord(low.key) ? ', ' + basisWord(low.key) : ''}).`;
      }
    }
    return { lines, tradeoff: tradeoff || null, cites: [...new Set(lines.flatMap((l) => l.cites))] };
  }
}
