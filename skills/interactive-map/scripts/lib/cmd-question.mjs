// `question`: scaffold the "question" block (ENGINE-SPEC-v0.2 §1) from data/metrics.json, so the verdict strip,
// lettered options, why-cards and lenses come from numbers the scripts measured — never from typed text.
import { parseArgs, makeOut, parseList, writeJSON, readJSON, UsageError, UserError, skipped as skipLine } from './util.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSite, loadLayer, configLayer, layerPath, STARTER_DIR } from './site.mjs';
import { readMetrics } from './metrics.mjs';
import { anchors as tieAnchors } from './validate-v2.mjs';
import { exists } from './util.mjs';
import { PHRASES_SV, LABELS_SV, LENS_SV, NOUNS_SV, WATCH_SV, GEN_SV } from './question-sv.mjs';

export const LANGS = ['en', 'sv'];

export const help = `question <dir> --kind choose-one|find-area|plan-route|find-place|explore --options <layer>
         --criteria key:weight,key:weight,… [--lenses sleep,night,move,morning] [--lens sleep] [--ask "…"] [--ids a,b,c]
         [--letters rank|given|false] [--top 5] [--lang en|sv] [--force] [--json]
  Writes "question" into map.config.json (and "version": 2). Labels, units and phrases come from data/metrics.json
  (written by enrich, areas, doorstep, photos and adapters). Refuses criteria that no option has (run the command
  that makes them first). ≤ 6 criteria, ≤ 4 lenses. Weight 0 = shown and may lead a verdict, but does not rank.
  Lens presets: sleep (23:00, "Light sleepers", quiet), night (20:00, "Night owls", lively, night markets),
  move (09:00, "Commuters", transit), morning (08:00, "Early risers", green). A preset only weights criteria you listed,
  except sleep: it ranks on the door (noise_night_db, else calm_night; added at weight 0 when not listed), the walk
  area is context. An option whose door and walk area disagree says both ("noisiest door at night, but quietest walk
  area").
  Letters follow the answer: choose-one options are lettered by their rank under the starting lens (A = the best
  match), written as options.ids, and stay fixed when a viewer switches lenses (--letters given keeps your order).
  Fast first: give the criteria you WANT; the ones not measured yet are "pending" (listed, skipped), and lenses with
  nothing to rank yet are left out, so the same command works right after places + enrich (MRT walk, café counts) and
  again, with --force, after each slower step (feel, areas…) refines it. Short keys resolve to what exists:
  "mrt" → walk_min_mrt (else nearest_mrt_m), "cafes" → cafes_10min / cafes_800m, walk_min_mrt → nearest_mrt_m when
  the walk was not routed. At least one criterion must exist.
  Prints the verdict lines exactly as the map shows them. A criterion made from partial data (metrics.json "partial",
  written by enrich) carries its caveat ("MRT data partial") and is never phrased shortest/longest; re-fetch it first.
  --lang sv  labels, verdict phrases, lens names and the map's own words (tabs, "Best by your weights") in Swedish; sets
             map.config.json "locale" (default: its "locale", else en). Write --ask in the user's language yourself.`;

// Area-derived counts are about the walk area, door metrics about the door: the wording says which (a hotel can have
// the quietest streets nearby and the loudest door at once, and the card must not read as a contradiction).
const PHRASES = {
  quiet_night_blocks: { lead: 'quietest streets nearby', value: '{value} quiet blocks nearby', worst: 'fewest quiet streets nearby ({value})', zero: 'no quiet streets nearby' },
  lively_night_blocks: { lead: 'liveliest streets nearby', value: '{value} lively blocks nearby', worst: 'fewest lively streets nearby ({value})', zero: 'no lively streets nearby' },
  quiet_day_blocks: { lead: 'calmest streets by day', value: '{value} calm blocks nearby', zero: 'no calm streets nearby' },
  lively_day_blocks: { lead: 'busiest streets by day', value: '{value} busy blocks nearby', zero: 'no busy streets nearby' },
  green_blocks: { lead: 'greenest walks', value: '{value} green blocks nearby', zero: 'no green streets nearby' },
  green: { lead: 'greenest doorstep' },
  green_area: { lead: 'greenest walks' },
  calm_night: { lead: 'quietest door at night', worst: 'noisiest door at night' },
  calm_night_area: { lead: 'quietest walk area at night' },
  lively_night: { lead: 'liveliest door at night' },
  lively_night_area: { lead: 'liveliest walk area at night' },
  // {value} of a decibel estimate is a word ("some traffic noise"), never "65 dB"
  noise_night_db: { lead: 'quietest door at night', value: '{value} at the door at night', worst: 'loudest door at night' },
  noise_day_db: { lead: 'quietest door by day', value: '{value} at the door by day', worst: 'loudest door by day' },
  amenities: { lead: 'most daily needs' },
  main_road_m: { lead: 'furthest from main roads', value: 'main road {value}', worst: 'closest to a main road ({value})' },
  tw_price_max: { lead: 'lowest filed max rate', value: 'filed max {value}' },
  nearest_night_market_m: { lead: 'closest night market', value: 'night market {value}' },
};
const LABELS = { green: 'Green doorstep', calm_night: 'Quiet door at night', lively_night: 'Lively door at night', amenities: 'Daily needs', green_area: 'Green walks',
  noise_night_db: 'Road noise at your door, night', noise_day_db: 'Road noise at your door, day', quiet_night_blocks: 'Quiet streets within a 10-min walk',
  lively_night_blocks: 'Lively streets within a 10-min walk', calm_night_area: 'Calm at night, 10-min walk area', green_blocks: 'Green streets within a 10-min walk' };
const LENS_PRESETS = {
  sleep: { emoji: '🛏', label: 'Sleep', persona: 'Light sleepers', time: 23, vibe: 0.1, like: /^(quiet|calm)|noise|main_road/, prefer: ['noise_night_db', 'calm_night', 'calm_night_area', 'quiet_night_blocks'], areas: ['quiet_night'] },
  night: { emoji: '🍜', label: 'Night', persona: 'Night owls', time: 20, vibe: 0.85, like: /^lively|night_?market|markets/, prefer: ['lively_night_blocks', 'lively_night_area', 'lively_night'], areas: ['lively_night'], show: ['nightmarkets', 'markets'] },
  move: { emoji: '🚇', label: 'Transit', persona: 'Commuters', time: 9, like: /^(walk|ride)_(min|km)_|mrt|metro|station/, prefer: ['walk_min_mrt'], show: ['mrt', 'metro', 'mrtwalk'] },
  morning: { emoji: '🌳', label: 'Morning', persona: 'Early risers', time: 8, vibe: 0.3, like: /green|park/, prefer: ['green_blocks', 'green_area', 'green'], areas: ['green'] },
};
// what a light sleeper hears at the door, best first (the dB model, else the calm estimate of the door's square)
const DOOR_KEYS = ['noise_night_db', 'calm_night'];
const words = (k) => k.replace(/_/g, ' ');
// layer ids → [one, many] for phrases ("6 min walk to the MRT", "23 cafés within 800 m")
const NOUNS = { cafes: ['café', 'cafés'], cafe: ['café', 'cafés'], coffee: ['café', 'cafés'], mrt: ['MRT', 'MRT stations'], metro: ['metro', 'metro stations'],
  nightmarkets: ['night market', 'night markets'], night_markets: ['night market', 'night markets'], markets: ['market', 'markets'], parks: ['park', 'parks'],
  gyms: ['gym', 'gyms'], restaurants: ['restaurant', 'restaurants'], food: ['place to eat', 'places to eat'], bars: ['bar', 'bars'], bakeries: ['bakery', 'bakeries'],
  supermarkets: ['supermarket', 'supermarkets'], convenience: ['convenience store', 'convenience stores'], stations: ['station', 'stations'], stops: ['stop', 'stops'] };
const nounOf = (id, lang = 'en') => {
  if (lang === 'sv' && NOUNS_SV[id]) return NOUNS_SV[id];
  if (NOUNS[id]) return NOUNS[id];
  const w = words(id);
  if (id.length <= 3) return [id.toUpperCase(), id.toUpperCase()];
  return [w.replace(/ies$/, 'y').replace(/s$/, ''), w];
};
// what makes a metric that is not there yet (said next to a pending criterion)
function madeBy(key, layer) {
  let m;
  if (/^(quiet|lively|calm|green|amenities)\w*_blocks$/.test(key)) return `uw feel + uw areas … --within walk --options ${layer}`;
  if (/_area$/.test(key)) return `uw feel + uw isochrone + uw enrich --layer ${layer} --feel-within walk`;
  if (/^(calm|lively)_(day|night)$|^green$|^amenities$|^noise_/.test(key)) return `uw feel + uw enrich --layer ${layer} --feel`;
  if ((m = key.match(/^(walk|ride)_min_(.+)$/))) { const l = m[2].replace(/_/g, '-'); return `uw places … --layer ${l} + uw enrich --layer ${layer} --route-to ${l}`; }
  if ((m = key.match(/^nearest_(.+)_m$/))) return `uw enrich --layer ${layer} --nearest ${m[1].replace(/_/g, '-')}`;
  if ((m = key.match(/^(.+)_(\d+)(min|m)$/))) return `uw places … --layer ${m[1].replace(/_/g, '-')} + uw enrich --layer ${layer} --count ${m[1].replace(/_/g, '-')}`;
  if (/^tw_/.test(key)) return `uw adapter tw-hotels <site> --layer ${layer} --records`;
  if (/main_road|street/.test(key)) return `uw doorstep <site> --layer ${layer}`;
  return 'the command that measures it';
}

export async function run(argv) {
  const args = parseArgs(argv, { kind: 'string', options: 'string', criteria: 'string', lenses: 'string', lens: 'string', ask: 'string', ids: 'string', letters: 'string', top: 'number', lang: 'string', force: 'bool' },
    { positionals: [1, 1], command: 'question' });
  if (args.help) return console.log(help);
  const out = makeOut(args);
  const site = openSite(args._[0]);
  const kind = args.kind || 'choose-one';
  if (!['choose-one', 'find-area', 'plan-route', 'find-place', 'explore'].includes(kind)) throw new UsageError('--kind must be choose-one, find-area, plan-route, find-place or explore');
  const cfg = readJSON(site.cfgPath);
  if (cfg.question && !args.force) throw new UserError('map.config.json already has a "question"; pass --force to replace it');
  if (args.lang !== undefined && !LANGS.includes(args.lang)) throw new UsageError(`--lang must be ${LANGS.join(' or ')}`);
  if (args.lang) cfg.locale = args.lang;
  const lang = LANGS.includes(cfg.locale) ? cfg.locale : 'en';
  const q = { kind };
  q.ask = (args.ask || cfg.description || cfg.title || '').slice(0, 70); // description = uw new --ask
  const warnings = [];
  let feats = [];
  if (kind !== 'explore' && kind !== 'plan-route') {
    if (!args.options) throw new UsageError('missing --options <layer> (the layer whose features are the answers)');
    if (!configLayer(site, args.options) && !exists(layerPath(site, args.options))) throw new UserError(`layer "${args.options}" does not exist`);
    feats = loadLayer(site, args.options).features.filter((f) => f?.properties?.id != null);
    q.options = { layer: args.options };
    if (args.ids) {
      const ids = parseList(args.ids);
      for (const id of ids) if (!feats.some((f) => String(f.properties.id) === id)) throw new UserError(`--ids: no ${args.options} feature "${id}"`);
      q.options.ids = ids;
      feats = ids.map((id) => feats.find((f) => String(f.properties.id) === id));
    }
    if (args.letters) q.options.letters = args.letters === 'false' ? false : args.letters;
    if (kind === 'find-place') q.options.top = args.top ?? 5;
    if (kind === 'choose-one' && (feats.length < 2 || feats.length > 5)) warnings.push(`choose-one works best with 2-5 options (this layer has ${feats.length}); use --ids or --kind find-place`);
  }
  const metrics = readMetrics(site.dir).metrics;
  const crit = [];
  const pending = [], resolved = [];
  const optionKeys = [...new Set(feats.flatMap((f) => Object.keys(f.properties || {}).concat(Object.keys(f.properties?.mean || {}))))];
  const haveN = (k) => feats.filter((f) => typeof (f.properties[k] ?? f.properties.mean?.[k]) === 'number').length;
  // a criterion that is not measured yet resolves to what the options do have ("mrt" → walk_min_mrt, "cafes" → cafes_800m)
  const resolve = (key) => {
    if (!feats.length || haveN(key)) return key;
    const counts = (base) => optionKeys.filter((k) => k.startsWith(base + '_') && /^\d+(min|m)$/.test(k.slice(base.length + 1)) && haveN(k))
      .sort((a, b) => (/min$/.test(b) - /min$/.test(a)) || haveN(b) - haveN(a));
    let m;
    const cands = [];
    if ((m = key.match(/^(walk|ride)_min_(.+)$/))) cands.push(`nearest_${m[2]}_m`);
    else if ((m = key.match(/^(.+)_(\d+)(min|m)$/))) cands.push(...counts(m[1]));
    else if (!/^nearest_|_m$/.test(key)) cands.push(`walk_min_${key}`, `nearest_${key}_m`, ...counts(key), `${key}_blocks`);
    return cands.find((k) => haveN(k)) || null;
  };
  for (const spec of parseList(args.criteria)) {
    const [key0, w] = spec.split(':');
    const weight = w === undefined ? 1 : Number(w);
    if (!Number.isFinite(weight) || weight < 0) throw new UsageError(`criterion "${spec}": weight must be a number ≥ 0`);
    const key = resolve(key0);
    if (!key) { pending.push({ key: key0, weight, made_by: madeBy(key0, q.options?.layer || 'hotels') }); continue; }
    if (key !== key0) resolved.push(`${key0} → ${key}${/^nearest_/.test(key) && /^(walk|ride)_min_/.test(key0) ? ' (straight line until the walk is routed)' : ''}`);
    if (crit.some((c) => c.key === key)) continue;
    if (feats.length) {
      const have = haveN(key);
      if (have < feats.length) warnings.push(`"${key}" is missing on ${feats.length - have} option(s): they show "—" and count as average with low confidence`);
      if (have < 2) warnings.push(`"${key}" exists on only one option, so it cannot tell options apart`);
    }
    if (!metrics[key]) warnings.push(`"${key}" has no metrics.json entry: label/unit/basis fall back to guesses`);
    crit.push(makeCriterion(key, weight, metrics, lang));
  }
  if (feats.length && !crit.length && pending.length) {
    // nothing measured yet: the map is fine without a question; say what to run first (exit 4 = skipped)
    throw skipLine(`question: no ${q.options.layer} option has ${pending.map((p) => p.key).join(', ')} yet (the map works without it). Measure one first, e.g. ${pending[0].made_by}; options know: ${optionKeys.filter((k) => haveN(k)).slice(0, 12).join(', ') || 'no numbers yet'}`);
  }
  // counts ("cafes_800m"): the fixed "20 is plenty" anchor makes a quiet street's 4 cafés look bad even when it is the
  // best of the options; scale it to what the options have (5-20), so the one with most cafés gets the credit
  for (const c of crit) {
    if (!/_\d+(min|m)$/.test(c.key) || /^(walk|ride)_/.test(c.key) || metrics[c.key]?.good != null && metrics[c.key]?.cmd !== 'enrich') continue;
    const vals = feats.map((f) => f.properties[c.key]).filter((v) => typeof v === 'number');
    if (vals.length < 2) continue;
    const G = Math.max(5, Math.min(20, Math.max(...vals)));
    if (G < 20) Object.assign(c, { good: G, bad: 0, threshold: G >= 8 ? 2 : 1 });
  }
  // a criterion every option ties on (all 20+ cafés: "plenty") cannot change the ranking; the engine would hide its
  // row and validate flags it (S6). Asked-for criteria stay visible ("always"): "every option has plenty" is an answer.
  const ties = [];
  const tieCheck = (c) => {
    const vals = feats.map((f) => f.properties[c.key] ?? f.properties.mean?.[c.key]).filter((v) => typeof v === 'number');
    if (vals.length < 2) return;
    const { threshold, cap } = tieAnchors({ ...metrics[c.key], ...c }, c.key);
    if (Math.max(...vals) - Math.min(...vals) < threshold || (cap != null && vals.every((v) => v >= cap)) || vals.every((v) => v === vals[0])) {
      c.always = true;
      ties.push(`${c.key} (${vals.join(' / ')}${cap != null && vals.every((v) => v >= cap) ? `, all ${cap}+` : ''})`);
    }
  };
  for (const c of crit) tieCheck(c);
  // light sleepers are decided by the door (the 200 m square the windows face), the walk area is what it is like
  // around: a hotel on a main road with quiet lanes behind must not win "Light sleepers" on its lanes. Whatever was
  // listed, the sleep lens ranks on a door metric when one exists (added at weight 0 if missing: shown, ranked by
  // the sleep lens only). At 6 criteria it takes the place of a tie (same for every option), else the lightest.
  const door = { key: null, added: false, dropped: null };
  if (parseList(args.lenses).includes('sleep') && feats.length > 1) {
    door.key = DOOR_KEYS.find((k) => crit.some((c) => c.key === k)) || null;
    const key = !door.key && DOOR_KEYS.find((k) => haveN(k) >= 2);
    if (key) {
      if (crit.length >= 6) {
        const light = [...crit].sort((a, b) => !!b.always - !!a.always || a.weight - b.weight || crit.indexOf(b) - crit.indexOf(a))[0];
        crit.splice(crit.indexOf(light), 1);
        door.dropped = light.key;
        const t = ties.findIndex((s) => s.startsWith(light.key + ' ('));
        if (t >= 0) ties.splice(t, 1);
      }
      const c = makeCriterion(key, 0, metrics, lang);
      crit.push(c);
      tieCheck(c);
      Object.assign(door, { key, added: true });
    }
  }
  // a lens with nothing to rank on only changes the clock: give it the option metric it is about, at weight 0
  // (shown on every card and ranked by that lens only; the starting ranking does not change)
  const autoCrit = [];
  for (const id of parseList(args.lenses)) {
    const P = LENS_PRESETS[id];
    if (!P || crit.some((c) => P.like.test(c.key)) || crit.length >= 6 || !feats.length) continue;
    const pref = (P.prefer || []).concat(Object.keys(metrics));
    const key = pref.find((k) => P.like.test(k) && !crit.some((c) => c.key === k) && feats.filter((f) => typeof (f.properties[k] ?? f.properties.mean?.[k]) === 'number').length >= 2);
    if (!key) continue;
    crit.push(makeCriterion(key, 0, metrics, lang));
    autoCrit.push(`${key}:0 (for the ${id} lens)`);
  }
  if (kind !== 'explore' && kind !== 'plan-route' && !crit.length) throw new UsageError('give --criteria key:weight,… (e.g. quiet_night_blocks:3,walk_min_mrt:2,green:1)');
  if (crit.length > 6) throw new UsageError('at most 6 criteria: choosing needs few dimensions');
  if (crit.length) q.criteria = crit;
  // lenses
  const lensIds = parseList(args.lenses);
  if (lensIds.length > 4) throw new UsageError('at most 4 lenses');
  const layerIds = new Set((cfg.layers || []).map((l) => l?.id));
  let areaLenses = new Set();
  try { const a = readJSON(layerPath(site, 'areas')); areaLenses = new Set((a.features || []).map((f) => f.properties?.lens)); } catch {}
  const lenses = [], pendingLenses = [];
  for (const id of lensIds) {
    const P = LENS_PRESETS[id];
    if (!P) throw new UsageError(`unknown lens preset "${id}" (presets: ${Object.keys(LENS_PRESETS).join(', ')}); edit map.config.json for custom lenses`);
    const weights = {};
    // the lens's own concern counts 3; getting around stays 1 (everyone walks to the train); the rest 0.
    // Sleep with a door metric: the door 3, the night walk area 1 (context), calm by day 0 (nobody sleeps then).
    // Night owls keep the walk area at 3: they go out into it, the door is not where their evening is.
    const own = (k) => id !== 'sleep' || !door.key ? 3 : k === door.key ? 3 : /_day(_|$)/.test(k) ? 0 : 1;
    for (const c of crit) weights[c.key] = P.like.test(c.key) ? own(c.key) : /^(walk|ride)_min_/.test(c.key) && c.weight ? 1 : 0;
    const W = lang === 'sv' ? { ...P, ...LENS_SV[id] } : P;
    const L = { id, emoji: P.emoji, label: W.label, ...(W.persona ? { persona: W.persona } : {}), time: P.time, ...(P.vibe != null ? { vibe: P.vibe } : {}), weights };
    const areas = (P.areas || []).filter((a) => areaLenses.has(a));
    if (areas.length) L.areas = areas;
    const show = (P.show || []).filter((s) => layerIds.has(s));
    if (show.length) L.show = show;
    if (!crit.some((c) => P.like.test(c.key))) {
      // options to rank but nothing this lens is about yet (no feel / areas): leave it out until a later run adds it
      if (feats.length > 1) { pendingLenses.push({ id, needs: (P.prefer || [])[0] || String(P.like) }); continue; }
      warnings.push(`lens "${id}" has no criterion to rank on (none of yours matches ${P.like}), so it only changes the time${P.vibe != null ? ' and vibe' : ''}. Add one at weight 0 (e.g. ${(P.prefer || [])[0] || 'a matching metric'}:0) after running the command that measures it, or drop the lens`);
    }
    lenses.push(L);
  }
  // one lens left with a persona: the persona line needs two that can disagree
  if (pendingLenses.length && lenses.filter((l) => l.persona).length === 1) for (const l of lenses) delete l.persona;
  if (lenses.length) q.lenses = lenses;
  // watched surroundings: a night market near an option is said on its card and in the night / sleep verdicts
  const watch = [];
  for (const k of new Set(feats.flatMap((f) => Object.keys(f.properties || {})))) {
    const m = k.match(/^nearest_(.+)_m$/); if (!m) continue;
    const lay = (cfg.layers || []).find((l) => l?.id === m[1] || l?.id === m[1].replace(/_/g, '-'));
    let isMarket = false;
    try { isMarket = !!lay && (loadLayer(site, lay.id).features || []).some((f) => /night_?market/.test(String(f.properties?.kind || ''))); } catch {}
    if (!isMarket || crit.some((c) => c.key === k)) continue;
    const sl = lenses.filter((l) => /sleep|quiet/.test(l.id)).map((l) => l.id);
    watch.push({ key: k, within: 400, label: lang === 'sv' ? WATCH_SV['Night market'] : 'Night market', ...(feats.some((f) => typeof f.properties[`nearest_${m[1]}_hours`] === 'string') ? { hours: `nearest_${m[1]}_hours` } : {}), ...(sl.length ? { lenses: sl } : {}) });
  }
  if (watch.length) q.watch = watch;
  if (args.lens) {
    if (!lensIds.includes(args.lens)) throw new UsageError(`--lens "${args.lens}" is not in --lenses`);
    // a starting lens that is still pending: start from your own weights until it can rank
    if (lenses.some((l) => l.id === args.lens)) q.lens = args.lens;
  }
  // letters follow the answer: rank the options the way the engine will under the starting lens, A = best
  let ranking = null;
  if (kind === 'choose-one' && feats.length > 1 && (args.letters || 'rank') !== 'given' && args.letters !== 'false') {
    try {
      ranking = await rankLikeEngine(site, cfg, q, feats, metrics);
      q.options.ids = ranking.map((r) => r.id);
      delete q.options.letters;
    } catch (e) { warnings.push(`could not rank the options for their letters (${e.message}); they keep the file order`); }
  }
  cfg.question = q;
  cfg.version = 2;
  writeJSON(site.cfgPath, cfg, { pretty: true });
  // the verdict as the map will show it (same engine), so the reply quotes it and its caveats exactly
  let verdict = null;
  if ((kind === 'choose-one' || kind === 'find-place') && feats.length > 1) {
    try {
      const Q = await engineQuestion(site, cfg, q, q.options.ids ? q.options.ids.map((id) => feats.find((f) => String(f.properties.id) === id)).filter(Boolean) : feats, metrics);
      verdict = { lines: Q.verdictLines().map((l) => ({ letter: l.letter, ref: l.ref, text: l.text, caveats: l.caveats || [] })), persona: Q.personaLine()?.text || null };
    } catch (e) { warnings.push(`could not preview the verdict (${e.message})`); }
  }
  const partial = crit.filter((c) => metrics[c.key]?.partial).map((c) => ({ key: c.key, caveat: metrics[c.key].caveat || `${c.key} data partial`, reason: metrics[c.key].partial_reason || 'incomplete input data', refetch: metrics[c.key].partial_refetch || null }));
  for (const w of warnings) out.warn(w);
  const pendingLines = [];
  if (resolved.length) pendingLines.push(`Using ${resolved.join(', ')}.`);
  if (pending.length) pendingLines.push(`Pending (not measured yet, left out): ${pending.map((p) => `${p.key} ← ${p.made_by}`).join('; ')}.`);
  if (pendingLenses.length) pendingLines.push(`Lenses left out until they can rank: ${pendingLenses.map((l) => `${l.id} (needs ${l.needs})`).join(', ')}${args.lens && !q.lens ? `; starting from your weights instead of "${args.lens}"` : ''}.`);
  // nothing weighted separates the options: the letters are the given order, not a pick (the engine says "Too close")
  const tiedAll = kind === 'choose-one' && feats.length > 1 && crit.filter((c) => c.weight > 0).every((c) => c.always);
  if (tiedAll) pendingLines.push(`NOTHING MEASURED YET SEPARATES THE OPTIONS: the letters are the order given, not a pick. Don't call A the best; say "too close to call so far" and measure next: ${(pending.find((p) => !/feel/.test(p.made_by)) || pending[0])?.made_by || 'a criterion where they differ (e.g. uw enrich … --route-to mrt)'}.`);
  if (door.added) pendingLines.push(`Added ${door.key}:0 for the sleep lens: light sleepers are decided by the door; the walk area is context${door.dropped ? ` (dropped ${door.dropped} to stay at 6 criteria)` : ''}.`);
  if (ties.length) pendingLines.push(`Same for every option, so it does not change the ranking (kept on the cards; say so in the reply): ${ties.join(', ')}.`);
  for (const p of partial) pendingLines.push(`PARTIAL DATA: ${p.key} → "${p.caveat}" on the verdict (${p.reason}). Say it in your reply; never call an option shortest/longest on it. Phase B, first: ${p.refetch || 're-fetch that layer'}, then enrich and this command again.`);
  if (pending.length || pendingLenses.length) pendingLines.push(`After those steps re-run this same command with --force: the verdict and letters update.`);
  out.result({ ok: true, question: q, ranking, verdict, partial, warnings, auto_criteria: autoCrit, door, pending, pending_lenses: pendingLenses, resolved, ties, tied_all: tiedAll }, [
    `Wrote "question" (${kind}) to map.config.json: ${crit.length} criteria (${crit.map((c) => `${c.key}×${c.weight}`).join(', ')})${lenses.length ? `, lenses ${lenses.map((l) => l.id).join(', ')}` : ''}; "version": 2.`,
    ...pendingLines,
    ...(autoCrit.length ? [`Added ${autoCrit.join(', ')}: weight 0 = shown on cards and ranked only by that lens.`] : []),
    ...(ranking ? [`Letters by rank${q.lens ? ` under "${q.lens}"` : ''}: ${ranking.map((r, i) => `${'ABCDE'[i]} ${r.id} (${r.score})`).join(' · ')}`] : []),
    ...(verdict ? [`Verdict as the map shows it:`, ...verdict.lines.map((l) => `  ${l.letter ? l.letter + ' ' : ''}${l.text}`), ...(verdict.persona ? [`  ${verdict.persona}`] : [])] : []),
    `Next: uw validate ${site.rel} --signal, then uw snapshot ${site.rel} --signal. The engine writes the verdict; never type one without "cites".`,
  ]);
  return 0;
}

export function makeCriterion(key, weight, metrics, lang = 'en') {
  const m = metrics[key] || {};
  const sv = lang === 'sv';
  // the walk-area minutes the areas command measured go into the label ("within a 12-min walk")
  const walkMin = (m.scale || '').match(/(\d+)-min walk/)?.[1];
  const label = sv && LABELS_SV[key] ? LABELS_SV[key].replace('10 min promenad', `${walkMin || 10} min promenad`)
    : (LABELS[key] || m.label || words(key)).replace(/\s*\(est\.\)$/, '').replace('10-min walk', `${walkMin || 10}-min walk`).slice(0, 44);
  let phrase = (sv && PHRASES_SV[key]) || PHRASES[key];
  let lab = label;
  const wm = key.match(/^(walk|ride)_min_(.+)$/);
  if (!phrase && wm) {
    const [n] = nounOf(wm[2], lang); const v = wm[1];
    phrase = sv ? GEN_SV.minutes(v, n) : { lead: `shortest ${v} to the ${n}`, value: `{value} ${v} to the ${n}`, worst: `longest ${v} to the ${n} ({value})` };
    if (sv && !LABELS_SV[key]) lab = GEN_SV.minutesLabel(v, n).slice(0, 44);
  }
  const nm = key.match(/^nearest_(.+)_m$/);
  if (!phrase && nm) {
    const [n] = nounOf(nm[1], lang);
    phrase = sv ? GEN_SV.nearest(n) : { lead: `closest to the ${n}`, value: `${n} {value} away`, worst: `furthest from the ${n} ({value})` };
    if (sv && !LABELS_SV[key]) lab = GEN_SV.nearestLabel(n).slice(0, 44);
  }
  // counts: "23 cafés within 800 m" / "most cafés nearby" / "fewest cafés nearby (4)"
  const cm = !wm && key.match(/^(.+)_(\d+)(min|m)$/);
  if (!phrase && cm) {
    const [, many] = nounOf(cm[1], lang);
    const scope = sv ? GEN_SV.countScope(cm[2], cm[3]) : cm[3] === 'min' ? `in a ${cm[2]}-min walk` : `within ${cm[2]} m`;
    // no radius in the phrase: a verdict number must be a measured value (S14); the label and why line say the scope
    phrase = sv ? GEN_SV.count(many) : { lead: `most ${many} nearby`, value: `{n} ${many} nearby`, worst: `fewest ${many} nearby ({n})`, zero: `no ${many} nearby` };
    if (!LABELS[key]) lab = `${many.charAt(0).toUpperCase()}${many.slice(1)} ${scope}`.slice(0, 44);
  }
  return { key, weight, label: lab, ...(phrase ? { phrase } : {}) };
}

/** Rank options exactly as the engine does (starter/engine/question.js, same percentiles against the feel grid). */
export async function rankLikeEngine(site, cfg, q, feats, metrics) {
  const Q = await engineQuestion(site, cfg, q, feats, metrics);
  return Q.rankList().map((r) => ({ id: r.o.id, score: Math.round(r.score * 1000) / 1000 }));
}
/** The engine's Question for this config (resolved; lens set), for ranking and the verdict preview. */
export async function engineQuestion(site, cfg, q, feats, metrics) {
  const { Question } = await import(pathToFileURL(path.join(STARTER_DIR, 'engine', 'question.js')).href);
  const gridDef = (cfg.layers || []).find((l) => l?.type === 'grid' && (!cfg.vibe?.grid || l.id === cfg.vibe.grid)) || (cfg.layers || []).find((l) => l?.type === 'grid');
  let gridFeats = [];
  try { if (gridDef) gridFeats = loadLayer(site, gridDef.id).features || []; } catch {}
  const cache = new Map();
  const percentile = (key, x) => {
    const field = String(key).replace(/_area$/, '');
    if (typeof x !== 'number' || !/^(calm_day|calm_night|lively_day|lively_night|green|amenities)$/.test(field)) return null;
    if (!cache.has(field)) { const v = gridFeats.filter((f) => !f.properties?.water).map((f) => f.properties?.[field]).filter((n) => typeof n === 'number').sort((a, b) => a - b); cache.set(field, v.length >= 20 ? v : null); }
    const vals = cache.get(field); if (!vals) return null;
    let lo = 0, hi = vals.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] <= x + 1e-9) lo = mid + 1; else hi = mid; }
    return lo / vals.length;
  };
  const Q = new Question({ ...q, options: { ...q.options, ids: feats.map((f) => String(f.properties.id)) } }, { locale: cfg.locale, metrics, compare: cfg.compare, verdict: cfg.verdict, features: () => feats, percentile });
  Q.lens = q.lens || null;
  Q.resolve();
  return Q;
}
