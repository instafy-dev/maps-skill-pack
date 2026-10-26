// `set`: edit a feature's properties (note, name, metrics…) or remove it, without geocoding or re-fetching anything.
import { parseArgs, makeOut, writeGeoJSON, UsageError, UserError } from './util.mjs';
import { openSite, loadLayer, layerPath } from './site.mjs';

export const help = `set <dir> <layer>:<id> [--note "…"] [--name "…"] [--emoji 🏨] [--props '{"price":120}'] [--unset key1,key2] [--remove] [--json]
  Changes properties of one feature in data/<layer>.geojson in place (other properties, metrics and geometry stay), or
  removes it (--remove). No network. Use it to fix a note, label or prop after add-point / enrich instead of re-running them.
  Geometry and "id" cannot be changed here (re-run add-point for a different place).`;

export async function run(argv) {
  const args = parseArgs(argv, { note: 'string', name: 'string', emoji: 'string', props: 'string', unset: 'string', remove: 'bool' },
    { positionals: [2, 2], command: 'set' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const m = String(args._[1]).match(/^([^:]+):(.+)$/);
  if (!m) throw new UsageError(`"${args._[1]}" must be <layer>:<featureId>, e.g. hotels:via-loft`);
  const [, layer, id] = m;
  const fc = loadLayer(site, layer);
  const i = fc.features.findIndex((f) => String(f?.properties?.id) === id);
  if (i < 0) {
    const ids = fc.features.map((f) => f?.properties?.id).filter(Boolean);
    throw new UserError(`no feature "${id}" in layer "${layer}". Ids: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', …' : ''}`);
  }
  const f = fc.features[i];
  let changed = [];
  if (args.remove) {
    fc.features.splice(i, 1);
    changed = ['(removed)'];
  } else {
    let extra = {};
    if (args.props) {
      try { extra = JSON.parse(args.props); } catch (e) { throw new UsageError(`--props is not valid JSON (${e.message}). Example: --props '{"price":120}'`); }
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new UsageError('--props must be a JSON object');
      if ('id' in extra) throw new UsageError('--props cannot change "id" (refs, votes and the URL hash use it)');
    }
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
    if (!changed.length) { out.result({ ok: true, layer, id, changed: [] }, [`Nothing changed on ${layer}:${id}.`]); return 0; }
  }
  writeGeoJSON(layerPath(site, layer), fc);
  out.result({ ok: true, layer, id, changed, removed: !!args.remove }, [
    args.remove ? `Removed ${layer}:${id} (${f.properties.name || ''}). Re-run enrich / legs / routes that used it.` : `Updated ${layer}:${id}: ${changed.join(', ')}.`,
  ]);
  return 0;
}
