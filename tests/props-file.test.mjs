// Props with words in them reach a feature without shell quoting (28 Oct 2026 drive: 3 of 18 map steps failed on
// `uw set … --props '{"why":"…Alfama's…"}'`, an apostrophe inside single-quoted JSON). `--props-file <file>` reads a
// file and `--props-file -` reads stdin, so a quoted heredoc carries any text; the skill says to use it.
// Run: node --test tests/props-file.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-props-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const env = { ...process.env, UW_NO_CACHE: '1' };
delete env.INSTAFY_CACHE_DIR;
/** One command line the way an agent's shell runs it: `bash -c '<line>'`. */
const sh = (line) => {
  const r = spawnSync('bash', ['-c', line], { cwd: tmp, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const uw = (args, input) => {
  const r = spawnSync(process.execPath, [UW, ...args], { cwd: tmp, env, encoding: 'utf8', input });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const props = (site, layer, id) => JSON.parse(fs.readFileSync(path.join(tmp, site, 'data', `${layer}.geojson`), 'utf8')).features.find((f) => f.properties.id === id).properties;
const WHY = 'Alfama\'s lanes and the "old" town, from $5 a tram ride';

function site(name) {
  assert.equal(uw(['new', name, '--title', 'Lisbon', '--center', '-9.14,38.71', '--zoom', '13']).code, 0);
  assert.equal(uw(['add-point', name, '--layer', 'sights', '--at', '-9.13,38.712', '--name', 'Alfama', '--id', 'alfama']).code, 0);
}

test('uw set: an apostrophe, quotes and a dollar sign reach the feature through a quoted heredoc on stdin', () => {
  site('s1');
  const line = `node ${JSON.stringify(UW)} set s1 sights:alfama --props-file - <<'JSON'\n${JSON.stringify({ why: WHY, stop: 'lisbon' })}\nJSON`;
  const r = sh(line);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Updated sights:alfama: why, stop\./);
  assert.equal(props('s1', 'sights', 'alfama').why, WHY);
  // what broke in the drive: the same object in single quotes is cut at the apostrophe by the shell
  const broken = sh(`node ${JSON.stringify(UW)} set s1 sights:alfama --props '${JSON.stringify({ why: "Alfama's lanes" })}'`);
  assert.notEqual(broken.code, 0);
});

test('uw add-point and uw set read --props-file from a file too; --props still works', () => {
  site('s2');
  fs.writeFileSync(path.join(tmp, 'why.json'), JSON.stringify({ why: WHY, source: 'Visit Lisboa' }));
  const a = uw(['add-point', 's2', '--layer', 'sights', '--at', '-9.135,38.711', '--name', 'Sé', '--id', 'se', '--props-file', 'why.json']);
  assert.equal(a.code, 0, a.err);
  assert.equal(props('s2', 'sights', 'se').why, WHY);
  assert.equal(props('s2', 'sights', 'se').source, 'Visit Lisboa');
  const b = uw(['add-point', 's2', '--layer', 'sights', '--at', '-9.136,38.712', '--name', 'Castelo', '--id', 'castelo', '--props-file', '-'], JSON.stringify({ why: WHY }));
  assert.equal(b.code, 0, b.err);
  assert.equal(props('s2', 'sights', 'castelo').why, WHY);
  assert.equal(uw(['set', 's2', 'sights:se', '--props', '{"price":12}']).code, 0);
  assert.equal(props('s2', 'sights', 'se').price, 12);
});

test('--props-file refuses what it cannot use, with a hint, and never changes the feature', () => {
  site('s3');
  const before = JSON.stringify(props('s3', 'sights', 'alfama'));
  const both = uw(['set', 's3', 'sights:alfama', '--props', '{"a":1}', '--props-file', '-'], '{"b":2}');
  assert.equal(both.code, 2);
  assert.match(both.err, /use --props or --props-file, not both/);
  const empty = uw(['set', 's3', 'sights:alfama', '--props-file', '-'], '');
  assert.equal(empty.code, 2);
  assert.match(empty.err, /--props-file - \(stdin\) is empty/);
  const bad = uw(['set', 's3', 'sights:alfama', '--props-file', '-'], "{'why': 'single quotes'}");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /is not valid JSON .*--props-file - <<'JSON'/);
  const list = uw(['set', 's3', 'sights:alfama', '--props-file', '-'], '[1,2]');
  assert.equal(list.code, 2);
  assert.match(list.err, /must be a JSON object/);
  const missing = uw(['set', 's3', 'sights:alfama', '--props-file', 'nope.json']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--props-file nope\.json: cannot read it \(ENOENT\)/);
  const id = uw(['set', 's3', 'sights:alfama', '--props-file', '-'], '{"id":"other"}');
  assert.equal(id.code, 2);
  assert.match(id.err, /cannot change "id"/);
  assert.equal(JSON.stringify(props('s3', 'sights', 'alfama')), before);
});

test('the skill sends props with words in them through stdin, never single-quoted JSON', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(md, /Props with words go on stdin \(`--props-file - <<'JSON'`, the object, then `JSON`\): an apostrophe breaks single-quoted JSON\./);
  const trip = fs.readFileSync(path.join(SKILL, 'reference', 'itinerary.md'), 'utf8');
  // every example that carries a "why" (words from a page) uses stdin
  for (const line of trip.split('\n').filter((l) => /--props '/.test(l))) assert.doesNotMatch(line, /"why"/, line);
  assert.match(trip, /--props-file - <<'JSON'\n\s*\{"stop":"<station id>","source_url":"https:\/\/…","source":"<site name>","why":"<what the page says to do there>"\}\n\s*JSON/);
});

// Every example the agent copies from (the skill, its references, every command's help and hints) keeps words out of
// single-quoted --props: a place, city or source name with an apostrophe ("L'Aquila", "the hotel's site") breaks the
// command the same way "Alfama's" did. Only numbers, booleans, ids and slugs stay inline.
test('no example puts words in single-quoted --props: the skill, its references and every help text use --props-file for them', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = [path.join(SKILL, 'SKILL.md'), ...walk(path.join(SKILL, 'reference')).filter((f) => f.endsWith('.md')), ...walk(path.join(SKILL, 'scripts')).filter((f) => f.endsWith('.mjs'))];
  const inline = /^(<[^<>]*\b(slug|id)>|[a-z0-9_-]*)$/;
  const words = [];
  for (const file of files) {
    for (const [, json] of fs.readFileSync(file, 'utf8').matchAll(/--props '([^']*)'/g)) {
      const values = [...json.matchAll(/"[^"]*"\s*:\s*("[^"]*"|…)/g)].map((m) => m[1]);
      if (values.some((v) => v === '…' || !inline.test(v.slice(1, -1)))) words.push(`${path.relative(SKILL, file)}: --props '${json}'`);
    }
  }
  assert.deepEqual(words, []);
});
