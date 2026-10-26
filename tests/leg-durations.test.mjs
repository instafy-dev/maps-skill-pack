// A leg's duration must be what the page it cites says (human-flows: "Hualien → Tainan · 3h45–4h45" was cited to a
// Wikivoyage page that says "about 3 hours"). `uw legs` reads each cited page again and drops a duration the page
// does not state; the card keeps the link as where to check the times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);

const GUIDE = '<html><body><h2>Get in</h2><p>Trains run north to Taipei (2 to 2½ hours by Puyuma) and less frequently to Tainan (about 3 hours). Walk 500 m to the bus station; buses take 90 minutes. Last train 21:40.</p></body></html>';

test('the travel times a page states, ranges kept as ranges, metres and clock times left out', async () => {
  const { pageDurations, pageStatesDuration } = await lib('durations.mjs');
  const found = pageDurations('Trains run north to Taipei (2 to 2½ hours by Puyuma) and less frequently to Tainan (about 3 hours). Walk 500 m; buses take 90 minutes. Last train 21:40. 3h45 by local train. 約3時間');
  assert.deepEqual(found.map((d) => [d.min, d.max]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), [[90, 90], [120, 150], [180, 180], [180, 180], [225, 225]]);
  assert.equal(pageStatesDuration(GUIDE, 180), true, '"about 3 hours" states 3h');
  assert.equal(pageStatesDuration(GUIDE, 225, 285), false, 'not 3h45–4h45');
  assert.equal(pageStatesDuration(GUIDE, 120, 150), true, 'the range as a range');
  assert.equal(pageStatesDuration(GUIDE, 135), false, 'never a midpoint of a range');
  assert.equal(pageStatesDuration(GUIDE, 500), false, '500 m is a distance');
  assert.equal(pageStatesDuration(GUIDE, 1300), false, 'a clock time is not a duration');
  assert.equal(pageStatesDuration('Express: 1 hr 50 min', 110), true);
  assert.equal(pageStatesDuration('所需時間：3小時45分', 225), true);
});

test('legs drop a duration their cited page does not state, keep one it does, and leave an unreadable page alone', async () => {
  const { confirmLegDurations } = await lib('cmd-routing.mjs');
  const leg = (name, duration, min, max, url) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    properties: { name, duration, duration_min: min, ...(max ? { duration_max_min: max } : {}), duration_source: 'research', duration_source_url: url } });
  const features = [
    leg('Hualien → Tainan', '3h45–4h45', 225, 285, 'https://en.wikivoyage.org/wiki/Hualien'),
    leg('Hualien → Taipei', '2h–2h30', 120, 150, 'https://en.wikivoyage.org/wiki/Hualien'),
    leg('Tainan → Kaohsiung', '30 min', 30, null, 'https://refused.example/timetable'),
  ];
  const seen = [];
  const dropped = await confirmLegDurations(features, {
    fetchPage: async (url) => { seen.push(url); return url.includes('refused') ? { refused: 'robots.txt' } : { status: 200, type: 'text/html', text: GUIDE }; },
  });
  assert.deepEqual(seen, ['https://en.wikivoyage.org/wiki/Hualien', 'https://refused.example/timetable'], 'each page read once');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].leg, 'Hualien → Tainan');
  assert.equal(dropped[0].gave, '3h45–4h45');
  assert.match(dropped[0].page_says, /3h/);
  const [tainan, taipei, kaohsiung] = features.map((f) => f.properties);
  assert.equal(tainan.duration, undefined, 'no unconfirmed time on the card');
  assert.equal(tainan.duration_min, undefined);
  assert.equal(tainan.duration_source_url, undefined);
  assert.equal(tainan.timetable_url, 'https://en.wikivoyage.org/wiki/Hualien', 'the link stays as where to check the times');
  assert.match(tainan.duration_note, /does not state/);
  assert.equal(taipei.duration, '2h–2h30', 'a stated range stays');
  assert.equal(taipei.duration_source_url, 'https://en.wikivoyage.org/wiki/Hualien');
  assert.equal(kaohsiung.duration, '30 min', 'an unreadable page is not held against the leg');
});
