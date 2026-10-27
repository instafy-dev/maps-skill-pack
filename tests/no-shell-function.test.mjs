// `uw` is a command on PATH in every shell (the manifest's `bin`), so nothing tells the agent to define a shell
// function first: every model command runs in a fresh shell, and the agent wrote `uw() { node …; }` before every one.
// Run: node --test tests/no-shell-function.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(REPO, 'skills', 'interactive-map');
const FUNCTION = /\buw\s*\(\s*\)\s*\{/;

test('SKILL.md, the recipes, the README and uw help define no uw() function', () => {
  const texts = {
    'SKILL.md': fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'),
    'reference/recipes.md': fs.readFileSync(path.join(SKILL, 'reference', 'recipes.md'), 'utf8'),
    'README.md': fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'),
    'uw help': execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'uw.mjs'), 'help'], { encoding: 'utf8' }),
  };
  for (const [name, text] of Object.entries(texts)) assert.doesNotMatch(text, FUNCTION, `${name} still defines uw()`);
});

test('SKILL.md says to run uw from PATH, with a way to run it where a shell does not find it', () => {
  const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(md, /Run `uw <command>`: it is on PATH in every shell/);
  assert.match(md, /`uw: not found`, run `node <this skill's folder>\/scripts\/uw\.mjs`/);
  const description = md.match(/^description: (.*)$/m)[1];
  assert.match(description, /\(uw new <dir> \.\.\.\)/);
  assert.doesNotMatch(description, /node \.agents/);
});
