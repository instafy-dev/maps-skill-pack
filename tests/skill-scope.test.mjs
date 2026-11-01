// What the skill claims. "Put the hours and the metro route on a small page I can share." loaded this skill (its
// description claimed any request that involves a map, "walks, routes, trips", and "route" was one of its routing
// words), so the turn made a 32-file map site, deleted its index.html and wrote the page by hand, served by `uw host`
// and blind to Studio's theme. The skill now claims a map, or places on one; a page of hours or directions is a page.
// A trip is still its own ("I'm travelling to Kyoto for 5 days, what should I see each day?"): "travel" stays a
// routing word (Instafy folds travelling, travels and traveling into it), as "trip" does.
// Run: node --test tests/skill-scope.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'interactive-map');
const md = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
const front = md.slice(0, md.indexOf('\n---', 4));
const description = /^description: (.*)$/m.exec(front)[1];
const keywords = /^routing_keywords: \[(.*)\]$/m.exec(front)[1].split(',').map((w) => w.trim());

test('the description claims a map, or places on one, and no request just because it has a route or a walk in it', () => {
  assert.match(description, /^REQUIRED when the answer is a map, or places on one \(choosing hotels or areas, places nearby, a trip's stays and sights, recolouring map features\)\./);
  assert.doesNotMatch(description, /any request|routes?\b|walks\b|directions|hours|page/i);
  // a way to get somewhere is not this skill's routing word; a trip is
  assert.ok(!keywords.includes('route'), 'routing word "route"');
  for (const w of ['map', 'maps', 'trip', 'travel', 'itinerary', 'where to stay', 'nearby']) assert.ok(keywords.includes(w), `routing word "${w}" stays`);
});

test('a page of hours or directions is built as a page, never inside a map site', () => {
  const flat = md.replace(/\s+/g, ' ');
  assert.match(flat, /- No map \(a plan, a list, a page of hours or directions\): `instafy bind init sites\/<slug> --starter timeline\|ranked\|blank`, never a map site\./);
});
