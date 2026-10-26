// Door vs walk area: light sleepers are decided by the door (calm_night / noise_night_db at the 200 m square the
// windows face); the walk area is what it is like around. Two Instafy runs on the same data listed different
// criteria (walk-area calm vs door calm) and named opposite "Light sleepers" picks; neither said that Lore has the
// noisiest door and the quietest walk area. Now the sleep lens ranks on the door whatever was listed, and an option
// whose door and walk area disagree says both, in the CLI preview and in the engine (the same Question class).
// Offline: no services; the hotels are written as the runs measured them.
// Run: node --test map-pack/tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the example sites are kept out of this repository (too large); tests that open one skip without them
const NO_EXAMPLES = fs.existsSync(path.join(HERE, '..', 'examples')) ? false : 'needs examples/ (not in this repository)';
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-door-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const uw = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [UW, ...args], { cwd: tmp, env: { ...process.env, UW_CACHE: path.join(tmp, 'cache'), UW_NO_CACHE: '1', UW_TURN_BUDGET: '0' } });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => { let json = null; if (args.includes('--json')) { try { json = JSON.parse(out); } catch {} } resolve({ code, out, err, json }); });
});
const file = (site, rel) => path.join(tmp, site, rel);
const engine = async () => (await import(pathToFileURL(path.join(SKILL, 'starter', 'engine', 'question.js')).href)).Question;

const pct = (label, scale) => ({ label, format: 'pct', better: 'higher', basis: 'estimated', confidence: 'low', source: 'uw feel (OpenStreetMap)', scale, threshold: 0.05 });
const METRICS = {
  calm_night: pct('Calm at night (est.)', 'the 200 m square at the door'),
  calm_night_area: pct('Calm at night, walk area (est.)', 'mean over the 10-min walk'),
  calm_day_area: pct('Calm by day, walk area (est.)', 'mean over the 10-min walk'),
  lively_day_area: pct('Lively by day, walk area (est.)', 'mean over the 10-min walk'),
  lively_night_area: pct('Lively at night, walk area (est.)', 'mean over the 10-min walk'),
  walk_min_mrt: { label: 'Walk to MRT', short: 'MRT', unit: 'min', format: 'int', better: 'lower', basis: 'routed', confidence: 'high', source: 'OSRM foot' },
  cafes_800m: { label: 'Cafes ≤800 m', unit: 'places', format: 'int', better: 'higher', basis: 'counted', confidence: 'low', source: 'OSM' },
  cafes_10min: { label: 'Cafes ≤10 min', unit: 'places', format: 'int', better: 'higher', basis: 'counted', confidence: 'medium', source: 'OSM' },
  lively_night_blocks: { label: 'Lively streets within a 10-min walk', unit: 'blocks', format: 'int', better: 'higher', basis: 'estimated', confidence: 'low', source: 'uw feel + uw areas' },
  quiet_night_blocks: { label: 'Quiet streets within a 10-min walk', unit: 'blocks', format: 'int', better: 'higher', basis: 'estimated', confidence: 'low', source: 'uw feel + uw areas' },
};
// as measured in runs 7 and 8 (door: calm_night; area: calm_night_area)
const HOTELS = {
  via: { name_en: 'Via Hotel Loft', c: [121.52455, 25.057824], calm_night: 0.63, calm_night_area: 0.51, walk_min_mrt: 6, calm_day_area: 0.51, lively_day_area: 0.66, lively_night_area: 0.65, cafes_800m: 117, cafes_10min: 67, lively_night_blocks: 9, quiet_night_blocks: 4 },
  everstar: { name_en: 'Everstar Hotel', c: [121.52471, 25.050524], calm_night: 0.38, calm_night_area: 0.27, walk_min_mrt: 7, calm_day_area: 0.29, lively_day_area: 0.65, lively_night_area: 0.69, cafes_800m: 117, cafes_10min: 75, lively_night_blocks: 14, quiet_night_blocks: 0 },
  lore: { name_en: 'Lore Hotel', c: [121.510855, 25.06345], calm_night: 0.10, calm_night_area: 0.72, walk_min_mrt: 2, calm_day_area: 0.72, lively_day_area: 0.23, lively_night_area: 0.22, cafes_800m: 34, cafes_10min: 29, lively_night_blocks: 0, quiet_night_blocks: 15 },
};
const RUN7 = 'calm_day_area:1,calm_night_area:3,lively_day_area:1,lively_night_area:2,walk_min_mrt:2,cafes_800m:1';
const RUN8 = 'calm_night:3,walk_min_mrt:2,cafes_10min:1,lively_night_blocks:0';

async function site(name, patch = {}) {
  assert.equal((await uw(['new', name, '--title', 'Which hotel?', '--center', '121.52,25.056', '--zoom', '14'])).code, 0);
  const features = Object.entries(HOTELS).map(([id, { c, ...p }]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, kind: 'hotel', ...p, ...(patch[id] || {}) } }));
  fs.writeFileSync(file(name, 'data/hotels.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  fs.writeFileSync(file(name, 'data/metrics.json'), JSON.stringify({ metrics: METRICS }));
  const cfgP = file(name, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'));
  cfg.layers = [...(cfg.layers || []), { id: 'hotels', title: 'Hotels', type: 'points', data: 'data/hotels.geojson', style: { emoji: '🏨' } }];
  fs.writeFileSync(cfgP, JSON.stringify(cfg, null, 2));
}
const question = (s, criteria) => uw(['question', s, '--kind', 'choose-one', '--options', 'hotels', '--criteria', criteria, '--lenses', 'sleep,night,move', '--lens', 'sleep', '--force', '--json']);
const loreLine = (q) => q.json.verdict.lines.find((l) => l.ref === 'hotels:lore');
const SPLIT = /noisiest door at night, but quietest walk area \(estimate\)/; // the trust word, as on the pages

test('the light-sleeper pick follows the door whichever criteria were listed; Lore says door and walk area', async () => {
  await site('r7'); await site('r8');
  const a = await question('r7', RUN7), b = await question('r8', RUN8);
  assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err);
  // run 7 listed only walk-area calm: the door is added at weight 0 (6 criteria: the tie on cafés makes room)
  assert.deepEqual(a.json.door, { key: 'calm_night', added: true, dropped: 'cafes_800m' });
  assert.equal(a.json.question.criteria.find((c) => c.key === 'calm_night').weight, 0);
  const sleep7 = a.json.question.lenses.find((l) => l.id === 'sleep').weights;
  assert.equal(sleep7.calm_night, 3, 'the door leads the sleep lens');
  assert.equal(sleep7.calm_night_area, 1, 'the night walk area is context');
  assert.equal(sleep7.calm_day_area, 0, 'calm by day does not decide sleep');
  assert.equal(a.json.question.lenses.find((l) => l.id === 'night').weights.lively_night_area, 3, 'night owls keep the walk area');
  assert.deepEqual(b.json.door, { key: 'calm_night', added: false, dropped: null });
  for (const q of [a, b]) {
    assert.equal(q.json.ranking[0].id, 'via', q.out);
    assert.match(q.json.verdict.persona, /^Light sleepers: A\b/);
    assert.match(loreLine(q).text, SPLIT, loreLine(q).text);
    assert.doesNotMatch(q.json.verdict.lines.find((l) => l.ref === 'hotels:via').text, /walk area/);
  }
  // the engine renders the same lines from map.config.json (the CLI preview is the same Question class)
  const Question = await engine();
  const feats = JSON.parse(fs.readFileSync(file('r8', 'data/hotels.geojson'), 'utf8')).features;
  const cfg = JSON.parse(fs.readFileSync(file('r8', 'map.config.json'), 'utf8'));
  const E = new Question(cfg.question, { metrics: METRICS, features: () => feats, percentile: () => null });
  E.lens = cfg.question.lens; E.resolve();
  assert.deepEqual(E.verdictLines().map((l) => l.text), b.json.verdict.lines.map((l) => l.text));
  const lore = E.opts.find((o) => o.id === 'lore');
  const w = E.why(lore).lines.find((l) => l.split);
  assert.match(w.text, /^Noisiest door at night, but quietest walk area$/);
  assert.deepEqual(w.cites, ['calm_night', 'calm_night_area']);
  assert.equal(w.basis, 'estimated');
  // a lens that weighs neither, on a full line: the why card says it, the line does not grow a third fact
  E.lens = 'night';
  assert.ok(E.verdictLines().every((l) => l.facts.length <= 2), E.verdictLines().map((l) => l.text).join(' | '));
  assert.equal((await uw(['validate', 'r7'])).code, 0);
  assert.equal((await uw(['validate', 'r8'])).code, 0);
});

test('a line that had both the walk-area fact and the door fact says the split once and keeps its best other fact', async () => {
  // quiet_night_blocks leads Lore's line and the loud door was its caveat: before, the split replaced only the first
  // ("noisiest door …, but quietest walk area · but noisiest door at night") and the 2-min MRT walk was gone
  await site('qb');
  const q = await question('qb', 'quiet_night_blocks:3,lively_night_blocks:2,walk_min_mrt:2,cafes_10min:1');
  assert.equal(q.code, 0, q.err);
  assert.equal(q.json.ranking[0].id, 'via', q.out);
  const t = loreLine(q).text;
  assert.match(t, SPLIT, t);
  assert.equal((t.match(/door/g) || []).length, 1, t);
  assert.match(t, /shortest walk to the MRT/, t);
});

test('door and walk area that agree: no split note', async () => {
  await site('agree', { lore: { calm_night: 0.75 } });
  const q = await question('agree', RUN8);
  assert.equal(q.code, 0, q.err);
  assert.equal(q.json.ranking[0].id, 'lore', 'quiet door, short walk');
  for (const l of q.json.verdict.lines) assert.doesNotMatch(l.text, /walk area/, l.text);
  const Question = await engine();
  const feats = JSON.parse(fs.readFileSync(file('agree', 'data/hotels.geojson'), 'utf8')).features;
  const E = new Question(q.json.question, { metrics: METRICS, features: () => feats, percentile: () => null });
  E.resolve();
  for (const o of E.opts) { assert.equal(E.splitFor(o), null, o.id); assert.ok(!E.why(o).lines.some((l) => l.split)); }
});

test('two options: a large door / walk-area gap is said without superlatives', async () => {
  const Question = await engine();
  const f = (id, door, area) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [121.5, 25.05] }, properties: { id, name_en: id, calm_night: door, calm_night_area: area, walk_min_mrt: 5 } });
  const feats = [f('a', 0.15, 0.7), f('b', 0.5, 0.55)];
  const E = new Question({ kind: 'choose-one', options: { layer: 'h' }, criteria: [{ key: 'calm_night', weight: 3 }, { key: 'walk_min_mrt', weight: 1 }] },
    { metrics: METRICS, features: () => feats, percentile: () => null });
  E.resolve();
  assert.equal(E.splitFor(E.opts[0]).text, 'noisy door at night, but quiet walk area');
  assert.equal(E.splitFor(E.opts[1]), null, 'a 0.05 gap is not a split');
});

test('the shipped Taipei example: one "but" per line, and the light sleepers\' pick (A) is not the loudest door', { skip: NO_EXAMPLES }, async () => {
  // review: "Light sleepers: A" sat next to A's own "noisiest door at night", and Lore's line had two "but"s
  const Question = await engine();
  const ex = path.join(HERE, '..', 'examples', 'taipei-stay');
  const cfg = JSON.parse(fs.readFileSync(path.join(ex, 'map.config.json'), 'utf8'));
  const feats = JSON.parse(fs.readFileSync(path.join(ex, 'data', 'hotels.geojson'), 'utf8')).features;
  const metrics = JSON.parse(fs.readFileSync(path.join(ex, 'data', 'metrics.json'), 'utf8')).metrics;
  const E = new Question(cfg.question, { metrics, features: () => feats, percentile: () => null });
  E.lens = cfg.question.lens; E.resolve();
  const lines = E.verdictLines();
  for (const l of lines) assert.ok((l.text.match(/\bbut\b/g) || []).length <= 1, l.text);
  assert.ok(lines.some((l) => /night market/.test(l.text)), 'the night market is still said');
  const persona = E.personaLine().text;
  const pick = /Light sleepers: (\w)/.exec(persona)?.[1];
  assert.equal(pick, 'A', persona);
  const loudest = Math.max(...E.opts.map((o) => E.value(o, 'noise_night_db')));
  assert.notEqual(E.value(E.opts.find((o) => o.letter === pick), 'noise_night_db'), loudest, persona);
});

test('each persona pick says why in plain words; a decibel estimate is said in words, never as "65 dB"', { skip: NO_EXAMPLES }, async () => {
  // review (v3): "Light sleepers: A" gave no reason (A and C both read "door 65 dB at night"), and dB is jargon
  const Question = await engine();
  const ex = path.join(HERE, '..', 'examples', 'taipei-stay');
  const cfg = JSON.parse(fs.readFileSync(path.join(ex, 'map.config.json'), 'utf8'));
  const feats = JSON.parse(fs.readFileSync(path.join(ex, 'data', 'hotels.geojson'), 'utf8')).features;
  const metrics = JSON.parse(fs.readFileSync(path.join(ex, 'data', 'metrics.json'), 'utf8')).metrics;
  const E = new Question(cfg.question, { metrics, features: () => feats, percentile: () => null });
  E.lens = cfg.question.lens; E.resolve();
  const p = E.personaLine();
  const by = Object.fromEntries(p.picks.map((x) => [x.label, x]));
  // A ties C at the door: the reason says the tie (review v4: a lone "quietest" hid it) and what sets A apart from C,
  // with C's value next to A's (B has the most quiet blocks, so "4" alone read like a strength)
  assert.equal(by['Light sleepers'].name, 'A');
  assert.equal(by['Light sleepers'].reason, 'quietest door at night, tied with C, and 4 quiet blocks nearby (C\u00a00)');
  assert.equal(by['Light sleepers'].estimate, true);
  assert.equal(by['Night owls'].reason, 'liveliest streets nearby');
  // a routed walk is a number people know: said with the lead, and not an estimate
  assert.equal(by['Commuters'].reason, 'closest MRT, 3 min');
  assert.equal(by['Commuters'].estimate, false);
  assert.match(p.text, /^Light sleepers: A \(quietest door at night, tied with C, and 4 quiet blocks nearby \(C\u00a00\), estimate\) · Night owls: C/);
  const all = [p.text, ...E.verdictLines().map((l) => l.text), ...E.opts.flatMap((o) => { const w = E.why(o); return [w.tradeoff, ...w.lines.map((l) => `${l.text} ${l.value}`)]; })].join('\n');
  assert.doesNotMatch(all, /\bdB\b/, all);
  // bands on the WHO night guideline (45 dB): a 65 dB door at night is loud, 20 dB over it (review v4: "some")
  assert.equal(E.fmt('noise_night_db', 65), 'loud traffic');
  assert.equal(E.fmt('noise_night_db', 72), 'loud traffic');
  assert.equal(E.fmt('noise_night_db', 58), 'some traffic noise');
  assert.equal(E.fmt('noise_night_db', 50), 'fairly quiet');
  assert.equal(E.fmt('noise_night_db', 44), 'quiet');
});

test('a persona reason never claims a lone "-est" on a value another option ties', async () => {
  const Question = await engine();
  const f = (id, walk, cafes) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [121.5, 25.05] }, properties: { id, name_en: id, walk_min_mrt: walk, cafes_10min: cafes } });
  const feats = [f('a', 3, 12), f('b', 3, 2), f('c', 12, 20)];
  const E = new Question({ kind: 'choose-one', options: { layer: 'h' }, criteria: [{ key: 'walk_min_mrt', weight: 3, phrase: { lead: 'closest MRT', value: 'MRT {value}' } }, { key: 'cafes_10min', weight: 1, cap: 30, phrase: { value: '{value} nearby' } }] },
    { metrics: METRICS, features: () => feats, percentile: () => null });
  E.resolve();
  const r = E.reasonFor(E.opts.find((o) => o.id === 'a'));
  assert.equal(r.text, 'closest MRT, 3 min, tied with B, and 12 places nearby (B\u00a02)');
});

test('a pick that leads on nothing is still given its best weighed reason', async () => {
  const Question = await engine();
  const f = (id, walk, cafes) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [121.5, 25.05] }, properties: { id, name_en: id, walk_min_mrt: walk, cafes_10min: cafes } });
  // b is second on both, first overall
  const feats = [f('a', 3, 0), f('b', 5, 16), f('c', 14, 20)];
  const E = new Question({ kind: 'choose-one', options: { layer: 'h' }, criteria: [{ key: 'walk_min_mrt', weight: 1, phrase: { lead: 'closest MRT' } }, { key: 'cafes_10min', weight: 1, cap: 20 }] },
    { metrics: METRICS, features: () => feats, percentile: () => null });
  E.resolve();
  const top = E.rankList()[0].o;
  assert.equal(top.id, 'b');
  const r = E.reasonFor(top);
  assert.ok(r && r.text && !/\bdB\b/.test(r.text), JSON.stringify(r));
  assert.equal(E.reasonFor(E.opts.find((o) => o.id === 'a')).text, 'closest MRT, 3 min');
});
