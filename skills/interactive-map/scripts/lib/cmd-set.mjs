// `set`: edit a feature's properties (note, name, metrics…) or remove it, without geocoding or re-fetching anything.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, makeOut, readJSON, writeJSON, writeGeoJSON, propsArg, UsageError, UserError } from './util.mjs';
import { openSite, loadLayer, layerPath, withSiteLock } from './site.mjs';
import { unnamedSource, unnamedSourceLine, sourceStamp, sourceNotRead, sourceNotReadRefusal } from './cmd-cite.mjs';

export const help = `set <dir> <layer>:<id> [--note "…"] [--name "…"] [--emoji 🏨] [--props '{"price":120}' | --props-file <file|->] [--unset key1,key2] [--remove] [--json]
set <dir> plan:day<N> --note "…" | --unset note [--json]
  Changes properties of one feature in data/<layer>.geojson in place (other properties, metrics and geometry stay), or
  removes it (--remove). No network. Use it to fix a note, label or prop after add-point / enrich instead of re-running them.
  plan:day1 is the plan's first day: --note gives that day its own line (a note for day 1: "book the tickets ahead"),
  shown under the day's text in the Plan tab, above its places (a map made before day notes keeps it but does not
  show it: said); --note "" or --unset note takes it off. A place's or a stop's note shows on its own card, never in a
  day. uw plan --force keeps each day's note.
  Geometry and "id" cannot be changed here (re-run add-point for a different place).
  A source_url that \`uw cite\` read (in the last hours) and that does not name the place is said at once: that page is
  not its source; cite the place's own page. A new source_url that \`uw cite\` did not read (or could not: HTTP 404,
  refused) is refused (exit 2, "cite it first", with the uw cite to run; nothing changed).
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
  if (!m) throw new UsageError(`"${args._[1]}" must be <layer>:<featureId>, e.g. hotels:via-loft (a day: plan:day1)`);
  const [, layer, id] = m;
  // a day of the plan (a site's own layer called "plan" keeps its features)
  if (layer === 'plan' && (DAY_REF.test(id) || !loadLayer(site, 'plan', { required: false }))) return setDayNote(args, out, site, id);
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
      // a new page no uw cite read is not the place's source yet: refused, nothing written (cmd-cite.mjs sourceNotRead)
      if (changed.includes('source_url') && sourceNotRead(f.properties.source_url)) return { f, changed: [], refused: f.properties.source_url };
      // a new page: when it was set (uw validate judges a page no uw cite read for a place this turn gave a source)
      if (changed.includes('source_url') || changed.includes('-source_url')) sourceStamp(f.properties, before);
    }
    writeGeoJSON(layerPath(site, layer), fc);
    // the place's items in the days link the page it cites (uw plan copied it there): a new page goes to them too
    const dayItems = !args.remove && changed.some((k) => /^-?source(_url)?$/.test(k)) ? withDayItems(site, layer, id, before, f.properties) : 0;
    return { f, changed, dayItems };
  });
  const { f, changed, dayItems, refused } = done;
  if (refused) {
    const { lines, next } = sourceNotReadRefusal(refused, f.properties.name_en || f.properties.name || id, 'Nothing was changed.');
    if (out.json) process.stdout.write(JSON.stringify({ ok: false, refused: 'source_not_read', layer, id, source_url: refused, next }, null, 2) + '\n');
    console.error(lines.join('\n'));
    return 2;
  }
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

const DAY_REF = /^(?:day-?)?(\d{1,3})$/i;
const DAY_NOTE_MAX = 120;

/** `uw set <site> plan:day<N> --note "…"`: day N's own line (a note for the day, a warning, a plan B), which the Plan
 *  tab shows under the day's text and above its places, as Instafy's timeline page shows a day's note. A day is not a
 *  feature: "Add a note to day 1: book the Alcázar tickets ahead." went on the city's stop (a 5 Nov 2026 run), whose
 *  card showed it while day 1 did not, and the reply said "as a day 1 note". --note "" or --unset note takes it off. */
function setDayNote(args, out, site, ref) {
  const n = DAY_REF.exec(ref)?.[1];
  if (!n) throw new UsageError(`"plan:${ref}" names no day: plan:day1 is the plan's first day, plan:day2 the second`);
  const other = ['name', 'emoji', 'props', 'props-file'].filter((k) => args[k] !== undefined).concat(args.remove ? ['remove'] : []);
  if (other.length) throw new UsageError(`a day takes --note "…" or --unset note; ${other.map((k) => `--${k}`).join(', ')} ${other.length === 1 ? 'is' : 'are'} for a place: uw set ${args._[0]} <layer>:<id> …`);
  const unset = (args.unset || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (unset.some((k) => k !== 'note')) throw new UsageError('a day can only take its note off: --unset note');
  if (args.note === undefined && !unset.length) throw new UsageError(`say what the day's note is: uw set ${args._[0]} plan:day${n} --note "<the note>"`);
  const note = args.note === undefined ? '' : String(args.note).replace(/\s+/g, ' ').trim();
  if (note.length > DAY_NOTE_MAX) throw new UsageError(`--note is ${note.length} characters: a day's note is one line under its text (≤ ${DAY_NOTE_MAX}); put the rest in the reply`);
  // map.config.json is read, changed and written under the site's write lock (another uw command may write it too)
  const { day, changed } = withSiteLock(site, () => {
    const cfg = readJSON(site.cfgPath);
    const days = Array.isArray(cfg?.plan?.days) ? cfg.plan.days : [];
    if (!days.length) throw new UserError(`this map has no plan, so no day ${n}: a trip's days come from uw plan (reference/itinerary.md)`);
    const i = Number(n) - 1;
    if (i < 0 || i >= days.length) {
      const list = days.slice(0, 6).map((d, j) => `day${j + 1}: ${d?.title || '(no title)'}`).join('; ');
      throw new UserError(`no day ${n}: the plan has ${days.length} day${days.length === 1 ? '' : 's'} (${list}${days.length > 6 ? '; …' : ''})`);
    }
    const d = days[i] && typeof days[i] === 'object' ? days[i] : (days[i] = {});
    const before = typeof d.note === 'string' ? d.note : '';
    if (before === note) return { day: d, changed: false };
    if (note) d.note = note; else delete d.note;
    writeJSON(site.cfgPath, cfg, { pretty: true });
    site.config = cfg;
    return { day: d, changed: true };
  });
  const title = String(day.title || `day ${n}`);
  // a map whose page came from a pack before day notes (its own engine/) does not show one: said, so the reply never
  // says the map shows a note nobody can see
  const shown = dayNotesShown(site);
  out.result({ ok: true, day: Number(n), title, note: note || null, changed: changed ? ['note'] : [], shown }, [
    !changed ? `Nothing changed on day ${n} (${title}).`
      : !note ? `Day ${n} (${title}) has no note now.`
        : shown ? `Day ${n} (${title}) has its note: "${note}". The Plan tab shows it under the day's text, above its places.`
          : `Day ${n} (${title}) has its note: "${note}", but this map's page was made before day notes and does not show it: the reply says it is saved with day ${n}, not that the map shows it.`,
  ]);
  return 0;
}

/** Does the site's own page draw a day's note (its engine/ui.js, copied from the pack when the map was made)? */
function dayNotesShown(site) {
  try { return fs.readFileSync(path.join(site.dir, 'engine', 'ui.js'), 'utf8').includes('uw-day-note'); } catch { return false; }
}

/** A place's items in the plan's days (`ref` = this place) link the page it cites, as uw plan wrote them (`url` =
 *  its source_url, `source` = its source): the place's new page goes to each item that linked its old one (or none,
 *  while it had none), so the Plan tab never links a page the place no longer cites and the days need no new plan
 *  (one groups them by area again, which undoes what the person moved). An item that links another page keeps it.
 *  `uw set` and `uw add-point` (a place pinned again under its id) call it holding the site lock. Returns how many
 *  items changed. */
export function withDayItems(site, layer, id, before, after) {
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
