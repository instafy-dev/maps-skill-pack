// `set`: edit a feature's properties (note, name, metrics…) or remove it, without geocoding or re-fetching anything.
import { parseArgs, makeOut, readJSON, writeJSON, writeGeoJSON, propsArg, UsageError, UserError } from './util.mjs';
import { openSite, loadLayer, layerPath, withSiteLock } from './site.mjs';
import { unnamedSource, unnamedSourceLine } from './cmd-cite.mjs';

export const help = `set <dir> <layer>:<id> [--note "…"] [--name "…"] [--emoji 🏨] [--props '{"price":120}' | --props-file <file|->] [--unset key1,key2] [--remove] [--json]
  Changes properties of one feature in data/<layer>.geojson in place (other properties, metrics and geometry stay), or
  removes it (--remove). No network. Use it to fix a note, label or prop after add-point / enrich instead of re-running them.
  Geometry and "id" cannot be changed here (re-run add-point for a different place).
  A source_url that \`uw cite\` read (in the last hours) and that does not name the place is said at once: that page is
  not its source; cite the place's own page.
  A new source_url or source goes to the place's items in the plan's days too (the Plan tab's link under it), so the
  days stay as they are: no new uw plan. An item that links another page is left as it is.
  Text with an apostrophe or quotes: --props-file - <<'JSON', the object on the next line, then JSON (no shell quoting).`;

export async function run(argv) {
  const args = parseArgs(argv, { note: 'string', name: 'string', emoji: 'string', props: 'string', 'props-file': 'string', unset: 'string', remove: 'bool' },
    { positionals: [2, 2], command: 'set' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const m = String(args._[1]).match(/^([^:]+):(.+)$/);
  if (!m) throw new UsageError(`"${args._[1]}" must be <layer>:<featureId>, e.g. hotels:via-loft`);
  const [, layer, id] = m;
  // the layer and map.config.json are read, changed and written under the site's write lock (another uw command may
  // write them at the same time); nothing here waits on the network
  const done = withSiteLock(site, () => {
    const fc = loadLayer(site, layer);
    const i = fc.features.findIndex((f) => String(f?.properties?.id) === id);
    if (i < 0) {
      const ids = fc.features.map((f) => f?.properties?.id).filter(Boolean);
      throw new UserError(`no feature "${id}" in layer "${layer}". Ids: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', …' : ''}`);
    }
    const f = fc.features[i];
    const before = { ...f.properties };
    let changed = [];
    if (args.remove) {
      fc.features.splice(i, 1);
      changed = ['(removed)'];
    } else {
      const extra = propsArg(args);
      if ('id' in extra) throw new UsageError('--props cannot change "id" (refs, votes and the URL hash use it)');
      if (args.note !== undefined) extra.note = args.note;
      if (args.name !== undefined) extra.name = args.name;
      // a Latin --name is also the English label when the feature has one (else OSM's old name_en keeps showing)
      if (args.name !== undefined && /[A-Za-z]/.test(args.name) && f.properties.name_en !== undefined && extra.name_en === undefined) extra.name_en = args.name;
      if (args.emoji !== undefined) extra.emoji = args.emoji;
      for (const [k, v] of Object.entries(extra)) { if (JSON.stringify(f.properties[k]) !== JSON.stringify(v)) changed.push(k); f.properties[k] = v; }
      // an English name given here answers the adapters' / areas' "needs_english" flag
      if (/[A-Za-z]/.test(extra.name_en || '') && f.properties.needs_english) { delete f.properties.needs_english; changed.push('-needs_english'); }
      for (const k of (args.unset || '').split(',').map((x) => x.trim()).filter(Boolean)) {
        if (k === 'id') throw new UsageError('cannot unset "id"');
        if (k in f.properties) { delete f.properties[k]; changed.push('-' + k); }
      }
      if (!changed.length) return { f, changed, dayItems: 0 };
    }
    writeGeoJSON(layerPath(site, layer), fc);
    // the place's items in the days link the page it cites (uw plan copied it there): a new page goes to them too
    const dayItems = !args.remove && changed.some((k) => /^-?source(_url)?$/.test(k)) ? withDayItems(site, layer, id, before, f.properties) : 0;
    return { f, changed, dayItems };
  });
  const { f, changed, dayItems } = done;
  if (!changed.length) { out.result({ ok: true, layer, id, changed: [] }, [`Nothing changed on ${layer}:${id}.`]); return 0; }
  // a page uw cite read that does not name the place is not its source: said now, while the turn can cite its own page
  // (two places once cited a routes page that named neither, and the reply vouched for it)
  const miss = !args.remove && changed.some((k) => k === 'source_url' || /^name/.test(k)) ? unnamedSource(f.properties) : null;
  out.result({ ok: true, layer, id, changed, removed: !!args.remove, ...(dayItems ? { day_items: dayItems } : {}), ...(miss ? { source_not_named: miss } : {}) }, [
    args.remove ? `Removed ${layer}:${id} (${f.properties.name || ''}). Re-run enrich / legs / routes that used it.` : `Updated ${layer}:${id}: ${changed.join(', ')}.`,
    dayItems ? `Its ${dayItems === 1 ? 'item' : `${dayItems} items`} in the plan's days link${dayItems === 1 ? 's' : ''} ${f.properties.source_url ? 'that page now' : 'no page now'}; the days are as they were.` : null,
  ]);
  if (miss) out.warn(unnamedSourceLine(miss, args._[0], `${layer}:${id}`));
  return 0;
}

/** A place's items in the plan's days (`ref` = this place) link the page it cites, as uw plan wrote them (`url` =
 *  its source_url, `source` = its source): the place's new page goes to each item that linked its old one (or none,
 *  while it had none), so the Plan tab never links a page the place no longer cites and the days need no new plan
 *  (one groups them by area again, which undoes what the person moved). An item that links another page keeps it.
 *  Call it holding the site lock. Returns how many items changed. */
function withDayItems(site, layer, id, before, after) {
  let cfg;
  try { cfg = readJSON(site.cfgPath); } catch { return 0; }
  const days = Array.isArray(cfg?.plan?.days) ? cfg.plan.days : [];
  const was = typeof before.source_url === 'string' && before.source_url ? before.source_url : null;
  let n = 0;
  for (const d of days) for (const it of Array.isArray(d?.items) ? d.items : []) {
    if (!it || typeof it !== 'object' || String(it.ref?.layer) !== layer || String(it.ref?.id) !== id) continue;
    if (!(was ? it.url === was : it.url === undefined)) continue;
    const url = after.source_url || null;
    const source = url && after.source ? String(after.source).slice(0, 40) : null;
    if ((it.url ?? null) === url && (it.source ?? null) === source) continue;
    if (url) it.url = url; else delete it.url;
    if (source) it.source = source; else delete it.source;
    n++;
  }
  if (n) { writeJSON(site.cfgPath, cfg, { pretty: true }); site.config = cfg; }
  return n;
}
