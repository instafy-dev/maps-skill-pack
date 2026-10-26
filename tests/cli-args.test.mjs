// CLI arguments: a flag that takes a value never swallows the next flag. In Instafy run 8 the agent ran
// `uw areas … --names --json`; --json became the value of --names and the command failed with a JSON parse error.
// Run: node --test map-pack/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../skills/interactive-map/scripts/lib/util.mjs';

const spec = { names: 'string', top: 'number', lens: 'string' };

test('a value flag followed by a known flag is a usage error naming both', () => {
  assert.throws(
    () => parseArgs(['site', '--names', '--json'], spec, { command: 'areas' }),
    /flag --names needs a value, got the flag --json/,
  );
  assert.throws(() => parseArgs(['site', '--top', '--lens=x'], spec, { command: 'areas' }), /--top needs a value/);
});

test('values still parse: JSON, negative numbers, and dash-led text that is not a flag', () => {
  const a = parseArgs(['site', '--names', '{"quiet_night-1":"Back lanes"}', '--top', '-0.5', '--lens', '--not-a-flag', '--json'], spec, { command: 'areas' });
  assert.equal(a.names, '{"quiet_night-1":"Back lanes"}');
  assert.equal(a.top, -0.5);
  assert.equal(a.lens, '--not-a-flag');
  assert.equal(a.json, true);
  assert.deepEqual(a._, ['site']);
});
