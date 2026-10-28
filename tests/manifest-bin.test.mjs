// The manifest names the pack's command (`bin`: `uw` on PATH in every shell) and a short, fixed label per `uw`
// subcommand (`activity`) for the chat's activity line, and both pass the rules a runtime checks them by: plain
// unreserved names, a file inside the pack, labels in plain words that only a count fills in.
// Run: node --test tests/manifest-bin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY, BIN, activityProblems, binProblems } from '../scripts/pack-commands.mjs';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const manifest = JSON.parse(fs.readFileSync(path.join(SKILL, '.instafy-pack.json'), 'utf8'));
// the subcommands `uw` has (scripts/uw.mjs COMMANDS)
const COMMANDS = (() => {
  const src = fs.readFileSync(path.join(SKILL, 'scripts', 'uw.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const COMMANDS = {'), src.indexOf('};', src.indexOf('const COMMANDS = {')));
  return [...block.matchAll(/^\s+'?([a-z][a-z-]*)'?:\s*\[/gm)].map((m) => m[1]);
})();

test('the manifest puts uw on PATH: a plain, unreserved name for scripts/uw.mjs inside the pack', () => {
  assert.deepEqual(manifest.bin, { uw: 'scripts/uw.mjs' });
  assert.deepEqual(manifest.bin, BIN);
  assert.equal(manifest.entry, 'scripts/uw.mjs', 'older runtimes keep their launcher');
  assert.deepEqual(binProblems(manifest.bin, SKILL), []);
});

test('the manifest labels every uw subcommand, and only real ones', () => {
  assert.deepEqual(manifest.activity, JSON.parse(JSON.stringify(ACTIVITY)));
  assert.deepEqual(Object.keys(manifest.activity), ['uw']);
  assert.ok(COMMANDS.length >= 30, COMMANDS.join(' '));
  const labelled = Object.keys(manifest.activity.uw);
  for (const command of COMMANDS) assert.ok(labelled.includes(command), `no label for uw ${command}`);
  for (const key of labelled) assert.ok(key === '*' || COMMANDS.includes(key), `${key} is not a uw command`);
  assert.deepEqual(activityProblems(manifest.activity, manifest.bin), []);
});

test('the labels say what a step did, in the words of the plan', () => {
  const uw = manifest.activity.uw;
  const done = (sub, n) => { const d = uw[sub].done; return typeof d === 'string' ? d : n === 1 ? d.one : n == null ? d.some : d.other.replace('{n}', n); };
  assert.equal(uw['add-point'].live, 'Looking up places');
  assert.equal(done('add-point', 14), 'looked up 14 places');
  assert.equal(done('add-point', 1), 'looked up a place');
  assert.equal(done('add-point', null), 'looked up places', 'a loop, uncounted');
  assert.equal(done('cite', 6), 'read 6 sources');
  assert.deepEqual(uw.validate, { live: 'Checking the map', done: 'built the map', role: 'outcome', when: 'success' });
  // A finished quiet step reads in the past tense in the turn's step list: "Working on the map" beside its check
  // mark read as still running.
  for (const sub of ['new', 'geocode', 'fit', 'serve', 'host', 'snapshot', 'wait', '*']) {
    assert.deepEqual(uw[sub], { live: 'Working on the map', done: 'worked on the map', role: 'quiet' }, sub);
  }
  for (const [sub, label] of Object.entries(uw)) assert.ok(label.done, `uw ${sub} has a past tense`);
  // nothing a page or a command prints can reach a label: they are fixed text here
  for (const [sub, label] of Object.entries(uw)) {
    for (const text of [label.live, ...(typeof label.done === 'object' ? Object.values(label.done) : [label.done ?? ''])]) {
      assert.doesNotMatch(text, /[<>[\]@]|:\/\/|www\./, `${sub}: ${text}`);
    }
  }
});

test('the rules refuse what a runtime refuses', () => {
  const bad = (activity) => activityProblems(activity, BIN);
  const ok = { live: 'Looking up places', done: { one: 'looked up a place', other: 'looked up {n} places', some: 'looked up places' } };
  assert.deepEqual(bad({ uw: { 'add-point': ok } }), []);
  const cases = [
    [{ other: { x: ok } }, /not a command in bin/],
    [{ uw: { 'add-point': { ...ok, live: 'looking up places' } } }, /upper-case/],
    [{ uw: { 'add-point': { ...ok, live: 'L'.padEnd(41, 'x') } } }, /over 40 characters/],
    [{ uw: { 'add-point': { ...ok, done: { ...ok.done, one: 'Looked up a place' } } } }, /lower-case/],
    [{ uw: { 'add-point': { ...ok, done: { ...ok.done, other: 'looked up places' } } } }, /needs \{n\}/],
    [{ uw: { 'add-point': { ...ok, done: { ...ok.done, one: 'looked up {n} place' } } } }, /may not hold \{n\}/],
    [{ uw: { 'add-point': { ...ok, done: { one: ok.done.one, other: ok.done.other } } } }, /some is required/],
    [{ uw: { 'add-point': { ...ok, done: { ...ok.done, other: `looked up {n} ${'p'.repeat(40)}` } } } }, /over 48 characters/],
    [{ uw: { cite: { live: 'Reading https://example.org', done: 'read it' } } }, /link/],
    [{ uw: { cite: { live: 'Reading www.example.org', done: 'read it' } } }, /link/],
    [{ uw: { cite: { live: 'Reading', done: 'read @someone' } } }, /mention/],
    [{ uw: { cite: { live: 'Reading <b>x</b>', done: 'read it' } } }, /markup/],
    [{ uw: { cite: { live: 'Reading [x](y)', done: 'read it' } } }, /markup/],
    [{ uw: { cite: { live: 'Reading {page}', done: 'read it' } } }, /brace/],
    [{ uw: { cite: { live: 'Reading‮', done: 'read it' } } }, /control/],
    [{ uw: { cite: { live: 'Reading\n', done: 'read it' } } }, /control/],
    [{ uw: { cite: { live: 'Reading', done: 'read it', role: 'loud' } } }, /role must be/],
    [{ uw: { cite: { live: 'Reading', done: 'read it', when: 'always' } } }, /when may only be/],
    [{ uw: { cite: { live: 'Reading' } } }, /done is required/],
    [{ uw: { 'Cite!': { live: 'Reading', done: 'read it' } } }, /not a subcommand name/],
    [{ uw: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`c${i}`, { live: 'Working', role: 'quiet' }])) }, /over 64/],
  ];
  for (const [activity, problem] of cases) {
    const problems = bad(activity);
    assert.ok(problems.some((p) => problem.test(p)), `${JSON.stringify(activity).slice(0, 120)} → ${problems.join('; ') || 'no problem'}`);
  }
  assert.match(binProblems({ node: 'scripts/uw.mjs' }, SKILL).join(), /not a plain, unreserved command name/);
  assert.match(binProblems({ Uw: 'scripts/uw.mjs' }, SKILL).join(), /not a plain, unreserved command name/);
  assert.match(binProblems({ uw: '../package.json' }, SKILL).join(), /not a file inside the pack/);
  assert.match(binProblems({ uw: 'scripts/missing.mjs' }, SKILL).join(), /not a file inside the pack/);
  assert.match(binProblems({ uw: 'scripts' }, SKILL).join(), /not a file inside the pack/);
  assert.match(binProblems(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`uw${i}`, 'scripts/uw.mjs'])), SKILL).join(), /over 8/);
});
