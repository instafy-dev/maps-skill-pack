// A vague ask is built on stated defaults, never answered with questions first (user principle: minimize what the
// user must approve). Oct 17: "Taiwan for two weeks in late Oct, help plan it?" got questions instead of a plan.
// Run: node --test map-pack/tests/no-ask-first.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const read = (rel) => fs.readFileSync(path.join(SKILL, rel), 'utf8');

test('SKILL.md: plan without asking, state the Assumed line, never ask to confirm a register match', () => {
  const md = read('SKILL.md');
  assert.match(md, /1\. Plan \(no tools, never ask: fill gaps for the `Assumed:` line\)/);
  assert.match(md, /the `Assumed:` line, what is estimated or partial/);
  assert.match(md, /a register match: name the\s+listing, never ask to confirm/);
  for (const phrase of ['ask at the end', 'name it, ask', 'ask for its address', 'Offer a demo']) {
    assert.ok(!md.includes(phrase), `SKILL.md still says ${phrase}`);
  }
});

test('itinerary.md: a vague trip is built on defaults, stated in one line, with one-tap follow-ups', () => {
  const md = read('reference/itinerary.md');
  assert.match(md, /Never stop to ask, even on a vague ask/);
  assert.match(md, /2 adults, mid-range hotels, a balanced pace, the length they gave \(none: 7 nights\)/);
  assert.match(md, /State every filled gap in ONE line/);
  assert.match(md, /2-3 one-tap follow-ups/);
  assert.match(md, /In Instafy they go in\s+`suggestions`: a plain-text reply ends with a fenced block tagged `suggestions`/);
  assert.match(md, /never a question the user must answer before the plan exists/);
});

test('uw geocode: a fuzzy register match tells the agent to name the listing, never to ask the user to confirm', () => {
  const src = read('scripts/lib/cmd-geocode.mjs');
  assert.match(src, /is shown as the registered listing \$\{regName\}/);
  assert.ok(!src.includes('ask them to confirm it is the place'), 'cmd-geocode still asks the user to confirm');
});
