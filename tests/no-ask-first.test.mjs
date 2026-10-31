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

test('itinerary.md: a vague trip is built on defaults, stated in one line', () => {
  const md = read('reference/itinerary.md');
  assert.match(md, /Never stop to ask, even on a vague ask/);
  assert.match(md, /2 adults, mid-range hotels, a balanced pace, the length they gave \(none: 7 nights\)/);
  assert.match(md, /State every filled gap in ONE line/);
});

// Instafy shows no suggestion chips under a reply: a reply that ended with a ```suggestions block showed it as text.
// Neither guide asks for one, nor for "one-tap follow-ups".
test('SKILL.md and itinerary.md ask for no suggestions block and no one-tap follow-ups', () => {
  for (const rel of ['SKILL.md', 'reference/itinerary.md']) {
    const md = read(rel);
    assert.doesNotMatch(md, /suggestions/, rel);
    assert.doesNotMatch(md, /one-tap|a chip per line/, rel);
  }
});

test('uw geocode: a fuzzy register match tells the agent to name the listing, never to ask the user to confirm', () => {
  const src = read('scripts/lib/cmd-geocode.mjs');
  assert.match(src, /is shown as the registered listing \$\{regName\}/);
  assert.ok(!src.includes('ask them to confirm it is the place'), 'cmd-geocode still asks the user to confirm');
});
