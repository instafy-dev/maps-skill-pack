// `snapshot --signal`: render the phone view in several states, read the engine's uw.signal() clutter report in each,
// apply rules S1-S15 (ENGINE-SPEC-v0.2 §11.2, §12.1) and write snapshots/signal.json. S15 (dark band at the horizon in
// steep 3D) is measured from the screenshot pixels, independent of the engine.
import fs from 'node:fs';
import path from 'node:path';

const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
// a phone on its side: the side panel is ~270 px wide, where why lines used to overlap their own text
const LANDSCAPE = { ...MOBILE, viewport: { width: 844, height: 390 } };

// Per-layer rendered symbol counts inside the visible map rect (for the fix hints).
const LAYER_COUNTS = (rect) => {
  const m = window.uw?.map;
  if (!m) return {};
  const box = rect ? [[rect[0], rect[1]], [rect[2], rect[3]]] : undefined;
  const ids = m.getStyle().layers.filter((l) => l.id.startsWith('uw-') && (l.type === 'symbol' || l.type === 'circle')).map((l) => l.id);
  const out = {};
  for (const id of ids) {
    let fs2 = [];
    try { fs2 = m.queryRenderedFeatures(box, { layers: [id] }); } catch {}
    const seen = new Set(fs2.map((f) => f.properties?.id ?? f.id ?? JSON.stringify(f.geometry?.coordinates)));
    if (seen.size) out[id] = seen.size;
  }
  return out;
};

// Row luminance (L*) of a screenshot inside the page: returns rows where a dark band sits (S15).
export const HORIZON = async ({ png, rect, gap, drop }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + png;
  await img.decode();
  const W = window.innerWidth, H = window.innerHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, W, H);
  const [x0, y0, x1, y1] = rect || [0, 0, W, H];
  const cx0 = Math.round(x0 + (x1 - x0) * 0.2), cx1 = Math.round(x0 + (x1 - x0) * 0.8);
  const data = g.getImageData(cx0, 0, Math.max(1, cx1 - cx0), H).data, w = Math.max(1, cx1 - cx0);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const Lstar = (Y) => (Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y);
  const L = new Array(H).fill(0);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; s += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]); }
    L[y] = Lstar(s / w);
  }
  const top = Math.round(y0 + (y1 - y0) * 0.45);
  const bands = [];
  for (let y = y0 + gap; y < Math.min(top, H - gap); y++) {
    const a = L[y - gap], b = L[y + gap];
    if (L[y] < a - drop && L[y] < b - drop) bands.push({ y, L: Math.round(L[y]), above: Math.round(a), below: Math.round(b) });
  }
  return { rows_checked: [y0 + gap, top], bands: bands.length, worst: bands.sort((p, q) => p.L - q.L)[0] || null };
};

export async function signalPass({ browser, base, dir, outDir, cfg, waitReady, args }) {
  const q = cfg.question || null;
  const lenses = Array.isArray(q?.lenses) ? q.lenses.filter((l) => l && l.id) : [];
  const v = cfg.view || {};
  const states = [{ name: 'default', hash: args.hash || '' }];
  for (const L of lenses) states.push({ name: `lens-${L.id}`, hash: `l=${encodeURIComponent(L.id)}`, lens: L, png: `mobile-lens-${L.id}.png` });
  states.push({ name: 't22', hash: 't=22' });
  if (q) states.push({ name: 'selected-A', hash: '', selectA: true });
  if (q && q.kind !== 'plan-route' && q.kind !== 'explore') states.push({ name: 'landscape-A', hash: '', selectA: true, ctx: LANDSCAPE, png: 'landscape-card.png' });
  if (Array.isArray(v.center)) {
    const z = Math.min(17, (v.zoom ?? 14) + 1.7);
    const cam = `@=${v.center[0]},${v.center[1]},${z.toFixed(1)},30,72`;
    states.push({ name: 'pitch72-day', hash: `${cam}&t=14`, horizon: true, png: 'mobile-pitch72-day.png' }, { name: 'pitch72-night', hash: `${cam}&t=22`, horizon: true, png: 'mobile-pitch72-night.png' });
  }
  const reports = [];
  for (const st of states) {
    const context = await browser.newContext({ ...(st.ctx || MOBILE), colorScheme: args.scheme || 'light', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`page error: ${(e.message || String(e)).split('\n')[0]}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource|GL Driver|GPU stall/.test(m.text())) errors.push(`console.error: ${m.text().slice(0, 200)}`); });
    const url = base + (st.hash ? '#' + st.hash : '');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ready = await waitReady(page);
    let selected = null;
    if (st.selectA) {
      selected = await page.evaluate(() => {
        const r = window.uw?.rank?.() || [];
        const a = r.find((x) => x.letter === 'A') || r[0];
        if (!a) return null;
        const i = a.ref.indexOf(':');
        window.uw.select(a.ref.slice(0, i), a.ref.slice(i + 1));
        return a.ref;
      }).catch(() => null);
      await page.waitForTimeout(1300);
      await page.evaluate(() => new Promise((res) => { const m = window.uw?.map; if (!m || (!m.isMoving() && m.loaded())) return res(); m.once('idle', res); setTimeout(res, 8000); })).catch(() => {});
    }
    await page.waitForTimeout(500);
    const has = await page.evaluate(() => typeof window.uw?.signal === 'function').catch(() => false);
    let report = null;
    if (has) report = await page.evaluate(() => { try { return window.uw.signal(); } catch (e) { return { error: String(e.message || e) }; } }).catch((e) => ({ error: e.message }));
    const counts = await page.evaluate(LAYER_COUNTS, report?.visible_rect || null).catch(() => ({}));
    let horizon = null;
    await page.screenshot(st.png ? { path: path.join(outDir, st.png) } : {});
    if (st.horizon) {
      // measure the map pixels only: hide every UI element above the canvas (toasts, buttons, sheet)
      await page.addStyleTag({ content: 'body *{visibility:hidden!important} .maplibregl-canvas-container,.maplibregl-canvas-container *{visibility:visible!important}' });
      await page.waitForTimeout(200);
      const bare = await page.screenshot();
      horizon = await page.evaluate(HORIZON, { png: bare.toString('base64'), rect: report?.visible_rect || null, gap: 12, drop: 18 }).catch((e) => ({ error: e.message }));
    }
    reports.push({ state: st.name, hash: st.hash, ready, selected, signal: report, layer_counts: counts, horizon, errors: [...new Set(errors)], png: st.png || null, lens: st.lens?.id || null });
    await context.close();
  }
  const rules = evaluate(reports, cfg, args);
  const doc = { generated_at: new Date().toISOString(), viewport: [390, 844], reports, rules };
  fs.writeFileSync(path.join(outDir, 'signal.json'), JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

function evaluate(reports, cfg, args) {
  const out = [];
  const add = (id, level, msg, fix) => out.push({ id, level, message: msg, fix });
  const q = cfg.question;
  const bud = { option: 5, support: 10, context: 80, ...(q?.budget || {}) };
  const labelsEn = (cfg.basemap?.labels ?? 'en') !== 'local';
  const top = (counts, re) => Object.entries(counts || {}).filter(([k]) => re.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k.replace(/^uw-/, '')} ${n}`).join(', ');
  const missing = reports.filter((r) => !r.signal || r.signal.error);
  if (missing.length) add('S0', 'fail', `uw.signal() unavailable in ${missing.length} state(s) (${missing[0].signal?.error || 'the engine has no uw.signal(): v0 engine?'})`, 'run: uw upgrade <site>');
  for (const r of reports) {
    for (const e of r.errors.slice(0, 3)) add('ERR', 'fail', `${r.state}: ${e}`, 'fix the console error');
    const s = r.signal;
    if (!s || s.error) continue;
    const where = r.state === 'default' ? 'by default' : r.lens ? `in lens "${r.lens}"` : `in state ${r.state}`;
    if (r.state === 'landscape-A') {
      if (s.why_overlap) add('S18', 'fail', `${s.why_overlap} overlapping piece(s) in why lines ${where}`, 'shorter criterion labels; the engine wraps below 330 px');
      if (s.tap_targets_small.length) add('S10', 'fail', `${s.tap_targets_small.length} tap target(s) under 44 px ${where}: ${s.tap_targets_small.slice(0, 3).join('; ')}`, 'engine/custom.js buttons and inline links need a 44 px hit area');
      continue;
    }
    const isLensOrDefault = r.state === 'default' || r.lens;
    if (isLensOrDefault && s.noise > s.noise_limit) {
      const fixLayers = top(r.layer_counts, /^uw-(?!.*(-hit|-label|-ring)$)/);
      add('S1', 'fail', `noise ${s.noise} > ${s.noise_limit} ${where}: ${s.symbols.support} support pins, ${s.symbols.cluster_bubbles} clusters, ${s.symbols.notes} notes, ${s.symbols.context_dots} dots${fixLayers ? ` (${fixLayers})` : ''}`,
        'set the busiest layer\'s "tier": "context", hide it, or lower question.budget.support');
    }
    const b = { ...bud, ...(r.lens ? (q?.lenses || []).find((l) => l.id === r.lens)?.budget || {} : {}) };
    if (s.symbols.support > b.support) add('S2', 'fail', `${s.symbols.support} support pins > budget ${b.support} ${where}`, 'lower the support layers or set some to context');
    if (s.symbols.context_dots > b.context) add('S2', 'fail', `${s.symbols.context_dots} context dots > budget ${b.context} ${where}`, 'set layers[].budget or question.budget.context');
    if (s.fill_coverage > 0.6) add('S3', 'fail', `fill covers ${Math.round(s.fill_coverage * 100)}% of the map ${where}`, 'hide the grid (expert) or lower area opacity / count');
    else if (s.fill_coverage > 0.45) add('S3', 'warn', `fill covers ${Math.round(s.fill_coverage * 100)}% of the map ${where}`, 'fewer or fainter areas');
    if (r.state === 'default') {
      if (s.basemap_labels > 25) add('S4', 'warn', `${s.basemap_labels} basemap labels on screen`, 'basemap.overrides: hide "pois" or minor labels');
      if (s.layers_without_legend.length) add('S5', 'fail', `layers with nothing saying what they are: ${s.layers_without_legend.join(', ')}`, 'give each a title or legend');
      if (s.compare_rows_no_diff.length) {
        const always = new Set((cfg.compare?.metrics || []).filter((m) => m.always).map((m) => m.key));
        const hard = s.compare_rows_no_diff.filter((k) => !always.has(k));
        if (hard.length) add('S6', 'fail', `compare rows where every option ties: ${hard.join(', ')}`, 'drop them from compare.metrics (or "always": true)');
        if (hard.length < s.compare_rows_no_diff.length) add('S6', 'warn', `tie rows kept with "always": ${s.compare_rows_no_diff.filter((k) => always.has(k)).join(', ')}`, '');
      }
      if (labelsEn && s.labels_without_english.length) add('S7', args.strict ? 'fail' : 'warn', `labels without English: ${s.labels_without_english.slice(0, 6).join(', ')}${s.labels_without_english.length > 6 ? ', …' : ''}`, 'add name_en (romanise; do not invent)');
      if (q && (!s.verdict.present || s.verdict.lines < 1 || s.verdict.uncited)) add('S8', 'fail', `verdict ${s.verdict.present ? `has ${s.verdict.lines} line(s), ${s.verdict.uncited} uncited` : 'is not visible in the peek'}`, 'check question.criteria values on the options');
      if (s.options.total && (s.options.visible < s.options.total || s.options.under_sheet)) add('S11', 'fail', `${s.options.visible}/${s.options.total} options visible, ${s.options.under_sheet} under the sheet`, 'run uw fit, or widen view.bounds');
      if (q && s.options.total && s.why.options_with_2plus_lines < s.options.total) add('S13', 'warn', `${s.options.total - s.why.options_with_2plus_lines} option(s) have fewer than 2 why lines with a basis`, 'add criteria that differ between options');
      if (q && s.verdict.uncited) add('S14', 'fail', `${s.verdict.uncited} verdict line(s) without cited metrics`, 'never type a verdict without cites');
      const unres = s.verdict.unresolved_numbers || [];
      if (q && unres.length) add('S14', 'fail', `verdict numbers that match no cited metric: ${unres.slice(0, 5).join(', ')}`, 'numbers must come from metrics or records: fix the authored text or its cites');
      if (q && s.compare && s.compare.rows > 5) add('S12', 'warn', `Compare shows ${s.compare.rows} rows by default`, 'fewer criteria / compare.metrics (the rest go under "more rows")');
    }
    if (['default', 't22', 'selected-A'].includes(r.state) && s.notes_over_pins) add('S9', 'fail', `${s.notes_over_pins} note bubble(s) over pins ${where}`, 'move the note to a ref, shorten it, or let the engine fold it into the card');
    // S16: every lens chip reachable where it is drawn
    if ((s.lens_chips_covered || []).length) add('S16', 'fail', `lens chip(s) covered or off screen ${where}: ${s.lens_chips_covered.join(', ')}`, 'fewer / shorter lens labels (engine wraps the row; custom.js must not cover it)');
    // S17: a verdict line cut off (number or basis lost), or not led by the top score
    if ((s.verdict?.truncated || []).length) add('S17', 'fail', `${s.verdict.truncated.length} verdict line(s) cut off ${where}: "${s.verdict.truncated[0]}…"`, 'shorter phrases (criterion phrase.lead / phrase.value), or verdict.facts: 1');
    if (s.verdict?.lead_not_top) add('S17', 'fail', `verdict ${where}: ${s.verdict.lead_not_top}`, 'engine ranking bug: upgrade the engine');
    // S18: why-line label, value and basis must not overlap (narrow side panel)
    if (s.why_overlap) add('S18', 'fail', `${s.why_overlap} overlapping piece(s) in why lines ${where}`, 'shorter criterion labels; the engine wraps below 330 px');
    // S19: the last agent results are on screen
    if (s.fresh_results && s.fresh_results.total && !s.fresh_results.visible) add('S19', 'warn', `none of the ${s.fresh_results.total} places from "${s.fresh_results.name}" is visible ${where}`, 'the engine frames fresh results; check the intent target layer');
    if (s.tap_targets_small.length) add('S10', 'fail', `${s.tap_targets_small.length} tap target(s) under 44 px ${where}: ${s.tap_targets_small.slice(0, 3).join('; ')}`, 'engine/custom.js buttons must be ≥ 44 × 44 px');
  }
  for (const r of reports.filter((x) => x.horizon)) {
    if (r.horizon?.error) add('S15', 'fail', `${r.state}: horizon check failed (${r.horizon.error})`, '');
    else if (r.horizon?.bands) add('S15', 'fail', `${r.state}: dark band at the horizon (${r.horizon.bands} row(s); worst L* ${r.horizon.worst.L} vs ${r.horizon.worst.above}/${r.horizon.worst.below} at y=${r.horizon.worst.y})`, 'engine look.js: fog/horizon colours must match the land (ENGINE-SPEC-v0.2 §12.1)');
  }
  // dedupe identical messages
  const seen = new Set();
  return out.filter((x) => { const k = x.id + x.message; if (seen.has(k)) return false; seen.add(k); return true; });
}
