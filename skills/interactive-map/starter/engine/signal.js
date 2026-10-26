// map-pack engine: uw.signal() — the in-page clutter report used by `uw snapshot --signal` (ENGINE-SPEC-v0.2 §11.1).
// Kit-owned file. Measures the current state over the visible map rect (viewport minus the sheet or side panel).
const LATIN = /[A-Za-z]/;
const nonLatinOnly = (s) => typeof s === 'string' && s.trim() !== '' && !LATIN.test(s);

export function signalReport(E, { pinBoxes, notes, compareModel2 }) {
  const map = E.map, ui = E.ui, Q = E.Q;
  if (!map || !E.layers) return { error: 'not ready' };
  const root = ui.root.getBoundingClientRect();
  const W = Math.round(root.width), H = Math.round(root.height);
  let rect;
  if (ui.side) { const s = ui.sheet.getBoundingClientRect(); rect = [Math.round(s.right - root.left), 0, W, H]; }
  else rect = [0, 0, W, Math.round(ui.sheet.getBoundingClientRect().top - root.top)];
  const [x0, y0, x1, y1] = rect;
  const inRect = (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const box = [[x0, y0], [x1, y1]];
  const q = (layers) => { const ids = layers.filter((id) => map.getLayer(id)); if (!ids.length) return []; try { return map.queryRenderedFeatures(box, { layers: ids }); } catch { return []; } };
  const uniq = (fs) => { const s = new Set(); return fs.filter((f) => { const k = f.layer.id.replace(/-(dot|rest)$/, '') + '|' + (f.properties?.id ?? f.id ?? JSON.stringify(f.geometry?.coordinates)); if (s.has(k)) return false; s.add(k); return true; }); };

  // options
  const opts = Q ? Q.opts : [];
  let visible = 0, under = 0;
  for (const o of opts) {
    const L = E.layers.byId.get(o.layer), f = L?.byFid.get(o.id); if (!f) continue;
    const pt = map.project(E.layers.featureCenter(L, f));
    if (inRect(pt)) visible++;
    else if (!ui.side && pt.x >= 0 && pt.x <= W && pt.y > y1 && pt.y <= H) under++;
  }
  // symbols by tier
  const idsBy = { option: [], support: [], context: [], cluster: [], areaLabels: [] };
  for (const L of E.layers.list) {
    if (L.error || !L.shown) continue;
    if (L.type === 'points') {
      if (L.tier === 'option') { idsBy.option.push(`uw-${L.id}`); idsBy.context.push(`uw-${L.id}-dot`, `uw-${L.id}-rest`); }
      else if (L.tier === 'context') idsBy.context.push(`uw-${L.id}-dot`, `uw-${L.id}`);
      else idsBy.support.push(`uw-${L.id}`);
      if (L.cluster) idsBy.cluster.push(`uw-${L.id}-cluster`);
    }
    if (L.type === 'legs') idsBy.support.push(`uw-${L.id}-badges`);
    if (L.verdict) idsBy.areaLabels.push(`uw-${L.id}-label`);
    if (L.type === 'legs' && L.numbered) idsBy.option.push(`uw-${L.id}-num`); // a route's numbered stops are its answer, not noise
  }
  idsBy.support.push('uw--reveal');
  // layers a site's custom.js drew and registered with uw.registerLayer(id, tier) count like the engine's own
  for (const [id, tier] of E.customTiers || []) if (idsBy[tier === 'option' ? 'option' : tier === 'context' ? 'context' : 'support']) idsBy[tier === 'option' ? 'option' : tier === 'context' ? 'context' : 'support'].push(id);
  const nOpt = uniq(q(idsBy.option)).length;
  const nSup = uniq(q(idsBy.support)).filter((f) => !f.properties?.cluster).length;
  const nCtx = uniq(q(idsBy.context)).length;
  const nCl = uniq(q(idsBy.cluster)).length;
  const nArea = uniq(q(idsBy.areaLabels)).length;
  const shownNotes = notes.filter((x) => !x.el.hidden && !x.el.classList.contains('is-gone'));
  const nNotes = shownNotes.filter((x) => { const r = x.btn.firstChild.getBoundingClientRect(); return r.right > root.left + x0 && r.left < root.left + x1 && r.bottom > root.top + y0 && r.top < root.top + y1; }).length;
  // basemap labels
  // basemap labels: symbol layers of the basemap's own vector source (not custom.js layers, whatever their id)
  const style = map.getStyle();
  const baseSym = style.layers.filter((l) => l.type === 'symbol' && l.source && style.sources[l.source]?.type === 'vector' && !l.id.startsWith('uw') && map.getLayoutProperty(l.id, 'visibility') !== 'none').map((l) => l.id);
  const nBase = uniq(q(baseSym)).length;
  // fill coverage on a 24 × 40 sample grid
  const fillIds = E.layers.list.filter((L) => L.shown && !L.error && (L.type === 'areas' || L.type === 'grid')).flatMap((L) => L.mapLayers).filter((id) => map.getLayer(id) && map.getLayer(id).type === 'fill');
  let hits = 0, n = 0;
  if (fillIds.length) for (let i = 0; i < 24; i++) for (let j = 0; j < 40; j++) {
    const px = [x0 + (i + 0.5) * (x1 - x0) / 24, y0 + (j + 0.5) * (y1 - y0) / 40];
    n++; try { if (map.queryRenderedFeatures(px, { layers: fillIds }).length) hits++; } catch { /* */ }
  } else n = 1;
  // notes over option/support pins (44 px boxes)
  const pins = pinBoxes();
  const hitR = (r, b) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
  let over = 0;
  for (const x of shownNotes) {
    const r = x.btn.firstChild.getBoundingClientRect(), own = x.n.at?.id != null ? String(x.n.at.id) : null;
    if (pins.some((b) => b.id !== own && hitR(r, b))) over++;
  }
  // legends
  const noLegend = [];
  for (const L of E.layers.list) {
    if (L.error || !L.shown) continue;
    const has = L.tier === 'option' || L.type === 'grid' && !ui.legendPill.hidden || (typeof L.def.legend === 'string' && L.def.legend) || L.verdict || (L.def.title && L.def.title !== L.id);
    if (!has) noLegend.push(L.id);
  }
  // compare rows with no difference among the shown rows
  const cmp = Q ? compareModel2() : null;
  const noDiff = [];
  if (cmp) for (const r of [...cmp.rows, ...cmp.extra]) if (r.key && r.cells.length > 1 && !r.cells.some((c) => c.best) && Q.leaders(r.key, Q.opts).length === Q.opts.length && Q.crit(r.key).always !== true) noDiff.push(r.key);
  // labels without English
  const noEn = [];
  const mode = E.config.basemap?.labels || 'en';
  if (mode !== 'local') {
    for (const o of opts) { const p = o.f.properties; if (!p.name_en && !p.short && nonLatinOnly(p.name)) noEn.push(o.ref); }
    for (const L of E.layers.list) {
      if (L.error || !L.shown) continue;
      if (L.verdict) for (const f of L.data.features) { const p = f.properties; if (p.needs_english || nonLatinOnly(p.name)) noEn.push(`${L.id}:${p.id}`); }
    }
    for (const f of uniq(q(idsBy.support))) { const p = f.properties || {}; if (p.id != null && !p.name_en && nonLatinOnly(p.name || p._label)) noEn.push(`${f.layer.id.replace(/^uw-/, '')}:${p.id}`); }
  }
  // verdict + why
  const lines = E.verdict?.lines || [];
  // S14: every number in a verdict line must be a formatted value of a metric it cites, on that line's option
  const unresolved = [];
  if (Q) for (const l of lines) {
    const o = l.ref ? Q.option(l.ref) : null;
    // names are not numbers to check ("Section 3"): drop the option's / area's own name and the area verdict
    let body = l.text;
    for (const x of [l.short, l.verdict]) if (x) body = body.split(x).join(' ');
    const nums = (body.match(/\d+(?:[.,]\d+)?/g) || []);
    if (!nums.length) continue;
    const allowed = new Set();
    for (const k of l.cites || []) {
      const v = o ? Q.value(o, k) : null;
      for (const t of [Q.fmt(k, v), Q.fmt(k, v, { unit: false })]) for (const n of String(t).match(/\d+(?:[.,]\d+)?/g) || []) allowed.add(n);
      // a cited text property (opening hours "18:00–00:00" of a watched place) carries its own numbers
      const raw = o?.f?.properties?.[k];
      if (typeof raw === 'string') for (const n of raw.match(/\d+(?:[.,]\d+)?/g) || []) allowed.add(n);
    }
    if (Q.kind === 'find-place') { allowed.add(String(Q.opts.length)); allowed.add(String(Q.candidates.length)); }
    if (l.day != null) continue; // plan lines: authored day titles
    for (const n of nums) if (!allowed.has(n)) unresolved.push(`${l.letter || ''} ${n}`.trim());
  }
  const vEl = ui.verdictEl;
  const vr = vEl?.getBoundingClientRect();
  const present = !!(vEl && vEl.offsetParent && vr && vr.height > 0 && vr.top < root.bottom);
  let why2 = 0;
  if (Q) for (const o of opts) { const w = Q.why(o, [], []); if (w.lines.filter((l) => l.basis).length >= 2) why2++; }
  // tap targets (inline text links count too: they need a 44 px hit box, e.g. a ::after, not just their text line)
  const small = [];
  const sel = 'button, a[href], [role="button"], [role="slider"], [role="switch"], input, select';
  for (const el of ui.root.querySelectorAll(sel)) {
    if (el.closest('.maplibregl-canvas-container') || el.closest('.uw-sr') || el.closest('.maplibregl-ctrl-attrib-inner')) continue;
    if (el.matches('a') && el.closest('p, .uw-photo-credit, .uw-note, dd, .uw-fact-s')) {
      const r0 = el.getBoundingClientRect();
      if (!r0.width || r0.bottom <= 0 || r0.top >= H) continue;
      const after = parseFloat(getComputedStyle(el, '::after').height) || 0;
      if (Math.max(r0.height, after) < 43.5) small.push(`a(inline) ${Math.round(r0.width)}×${Math.round(r0.height)} "${el.textContent.trim().slice(0, 24)}"`);
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) continue;
    const cx = Math.min(W - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    if (!top || !(el === top || el.contains(top) || top.contains(el))) continue; // covered or scrolled out of its panel
    if (r.width < 43.5 || r.height < 43.5) small.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} ${Math.round(r.width)}×${Math.round(r.height)}${el.textContent ? ' "' + el.textContent.trim().slice(0, 24) + '"' : ''}`);
  }
  // lens chips: every chip must be reachable where it is drawn (not under another chip, not scrolled away)
  const lensCovered = [];
  for (const el of ui.root.querySelectorAll('.uw-lens')) {
    const r = el.getBoundingClientRect(); if (!r.width || !el.offsetParent) continue;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || !(top === el || el.contains(top))) lensCovered.push((el.textContent || '').trim().slice(0, 20));
    else if (r.right > W + 0.5 || r.left < -0.5) lensCovered.push((el.textContent || '').trim().slice(0, 20) + ' (off screen)');
  }
  // verdict lines: none cut (a clamp or an ellipsis that hides a number or its basis)
  const truncated = [];
  for (const el of ui.root.querySelectorAll('.uw-vline-t')) { if (!el.offsetParent) continue; if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) truncated.push(el.textContent.trim().slice(0, 40)); }
  // the first verdict line is the top score under the active lens (choose-one / find-place)
  let leadNotTop = null;
  if (Q && (Q.kind === 'choose-one' || Q.kind === 'find-place') && lines[0]?.ref) { const top = Q.rankList()[0]?.o?.ref; if (top && top !== lines[0].ref) leadNotTop = `${lines[0].ref} leads but ${top} scores highest`; }
  // why lines: the label, value and basis chip of one row must not overlap (narrow side panels)
  let whyOverlap = 0;
  const ov = (a, b) => a.width && b.width && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  for (const row of ui.root.querySelectorAll('.uw-whyline')) {
    if (!row.offsetParent) continue;
    const kids = [...row.children].map((k) => k.getBoundingClientRect());
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (ov(kids[i], kids[j])) whyOverlap++;
  }
  // fresh agent results (last finished job): how many of its places are drawn inside the visible rect
  let fresh = null;
  if (E.fresh?.refs?.length) {
    let vis = 0;
    for (const ref of E.fresh.refs) { const i = ref.indexOf(':'); const L = E.layers.byId.get(ref.slice(0, i)); const f = L?.byFid.get(ref.slice(i + 1)); if (!f || !L.shown) continue; const pt = map.project(E.layers.featureCenter(L, f)); if (inRect(pt)) vis++; }
    fresh = { name: E.fresh.name, total: E.fresh.refs.length, visible: vis };
  }
  const noise = nSup + nCl + nNotes + 0.25 * nCtx;
  return {
    viewport: [W, H], visible_rect: rect,
    state: { lens: Q?.lens ?? null, hour: E.hour, selected: E.sel ? `${E.sel.layer}:${E.sel.id}` : null },
    options: { total: opts.length, visible, under_sheet: under },
    symbols: { option: nOpt, support: nSup, context_dots: nCtx, cluster_bubbles: nCl, area_labels: nArea, notes: nNotes },
    basemap_labels: nBase,
    fill_coverage: Math.round((hits / n) * 1000) / 1000,
    notes_over_pins: over,
    layers_without_legend: noLegend,
    compare_rows_no_diff: noDiff,
    compare: cmp ? { rows: Math.max(0, cmp.rows.length - 1), more: cmp.extra.length, hidden_ties: cmp.hidden.length } : null,
    labels_without_english: [...new Set(noEn)],
    verdict: { present: !!Q && present && lines.length > 0, lines: lines.length, uncited: lines.filter((l) => !l.cites?.length).length, unresolved_numbers: unresolved, truncated, lead_not_top: leadNotTop },
    lens_chips_covered: lensCovered,
    why_overlap: whyOverlap,
    fresh_results: fresh,
    why: { options_with_2plus_lines: why2 },
    tap_targets_small: small,
    noise: Math.round(noise * 100) / 100, noise_limit: 2 * visible + 6,
  };
}
