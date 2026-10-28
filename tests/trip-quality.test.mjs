// Trip quality fixes (eval readback, 2026-10-15): uw plan's hours are lighting hints, not clock times; a plan whose
// full days are still empty is flagged (validate) and the turn clock says to fill them; a station walk that routing
// sends round the block falls back to the straight line; --kind hsr never writes the conventional station; an HSR
// station's English name says HSR; a station far from the centre is called out; `uw handoff` re-reads cited pages
// and drops a source that does not name the place; a leg's sourced duration may be a range.
// Offline. Run: node --test map-pack/tests/trip-quality.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..', 'skills', 'interactive-map');
const UW = path.join(SKILL, 'scripts', 'uw.mjs');
const lib = (f) => import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', f)).href);
const { buildPlan, emptyPlanDays } = await lib('cmd-plan.mjs');
const { clockAdvice } = await lib('turn-advice.mjs');
const { reconcileStationWalk, hsrEnglishName, farFromCentreAdvice, rankStays } = await lib('cmd-stay.mjs');
const { pageNamesPlace, checkSources, checkHandoff, planFromHandoff } = await lib('cmd-handoff.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-tq-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const stop = (id, name, coord) => ({ id, layer: 'stations', props: { id, name, name_en: name, station_of: name }, coord });
const lisbonPorto = () => buildPlan({ stops: [stop('porto', 'Porto', [-8.585, 41.149]), stop('lisbon', 'Lisbon', [-9.141, 38.714]), stop('porto', 'Porto', [-8.585, 41.149])],
  nights: [3, 4, 0], start: '2027-05-07' });

test('uw plan hours are lighting hints: every generated day says so', () => {
  const plan = lisbonPorto();
  assert.ok(plan.days.length >= 7);
  for (const d of plan.days) assert.equal(d.time_hint, true, d.title);
});

test('empty full days are counted; the turn clock prints facts, the skill decides', () => {
  const plan = lisbonPorto();
  const gaps = emptyPlanDays(plan);
  assert.equal(gaps.full, 5, 'Porto 2 + Lisbon 3 full days');
  assert.equal(gaps.empty, 5);
  const busy = clockAdvice(323, gaps, 480);
  assert.match(busy, /time: 5m23s used, about 2m37s left for tool work this turn\./);
  assert.match(busy, /5 of 5 full days are still empty/);
  // no phase recipe in the tool: what to do with the facts is the skill's (SKILL.md, itinerary.md Phase B)
  assert.doesNotMatch(busy, /Phase B|add 2-3|One more|Serve \+ post/);
  assert.match(clockAdvice(500, gaps, 480), /No time left for network steps: reply/, 'past the budget');
  // one unsourced or city-page item a day (finish-taiwan-big: 6 of 7 full days had exactly one sight) is thin
  for (const d of plan.days) d.items.push({ text: 'Sight', url: 'https://en.wikivoyage.org/wiki/Porto' });
  assert.equal(emptyPlanDays(plan).empty, 0);
  assert.equal(emptyPlanDays(plan).thin, 5);
  assert.match(clockAdvice(323, emptyPlanDays(plan), 480), /5 of 5 full days have fewer than 2 sourced sights/);
  for (const d of plan.days) d.items.push({ text: 'Sight 2', url: 'https://example.org/sight-2' });
  assert.equal(emptyPlanDays(plan).thin, 0);
  assert.doesNotMatch(clockAdvice(323, emptyPlanDays(plan), 480), /full days/);
});

test('the base is the researched hotel, with its reason and link; the plan prints the route with nights', async () => {
  const { routeLine } = await lib('cmd-plan.mjs');
  const tainan = stop('tainan', 'Tainan', [120.213, 22.997]);
  const taipei = stop('taipei', 'Taipei', [121.517, 25.046]);
  const stays = [
    { _layer: 'stays', properties: { id: 'tainan-tw-007698', name: '嘉樂行旅', stop: 'tainan', rank: 1, why: 'registered hotel, 40 rooms' }, geometry: { type: 'Point', coordinates: [120.214, 22.996] } },
    { _layer: 'stays', properties: { id: 'tainan-hotel-tainan', name: 'Hotel Tainan', stop: 'tainan', researched: true, why: 'directly opposite the station exit',
      source_url: 'https://www.hotel-tainan.com.tw/', walk_min: 3 }, geometry: { type: 'Point', coordinates: [120.212, 22.996] } },
    { _layer: 'stays', properties: { id: 'taipei-tw-1', name: '玫瑰香榭飯店', stop: 'taipei', rank: 1, why: 'registered hotel, 16 rooms', website: 'https://champderoseshotel.com.tw' }, geometry: { type: 'Point', coordinates: [121.518, 25.045] } },
  ];
  const plan = buildPlan({ stops: [tainan, taipei], nights: [2, 1], start: '2026-10-20', stays });
  const base = plan.days[0].items.find((it) => /^Base:/.test(it.text));
  assert.match(base.text, /^Base: Hotel Tainan · 3 min walk to the station · directly opposite the station exit$/);
  assert.equal(base.url, 'https://www.hotel-tainan.com.tw/');
  assert.equal(base.ref.id, 'tainan-hotel-tainan');
  // a register pick links its own website, without the register's boilerplate
  const tpe = plan.days.find((d) => d.title.includes('→')).items.find((it) => /^Base:/.test(it.text));
  assert.equal(tpe.url, 'https://champderoseshotel.com.tw');
  assert.doesNotMatch(tpe.text, /registered hotel/);
  assert.equal(routeLine([tainan, taipei], [2, 1], plan), 'Tainan 2 → Taipei 1 (3 nights, Tue 20 Oct – Fri 23 Oct)');
});

test('validate warns on a mostly empty plan and checks time_hint', () => {
  const dir = path.join(tmp, 'site');
  const r = spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Trip', '--center', '-8.6,41.1', '--zoom', '7'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cfgPath = path.join(dir, 'map.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.plan = { title: 'Plan', days: lisbonPorto().days.map(({ focus, ...d }) => d) };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const v = spawnSync(process.execPath, [UW, 'validate', dir], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout + v.stderr, /5 of 5 full days are still empty/);
  cfg.plan.days[0].time_hint = 'yes';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const bad = spawnSync(process.execPath, [UW, 'validate', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /time_hint must be true or false/);
});

test('a routed station walk that goes round the block falls back to the straight line (Tainan: Hotel Tainan)', () => {
  // OSRM from the snapped station node: 888 m to Hotel Tainan, 246 m away in a straight line; Shangri-La 342 m
  const hotelTainan = reconcileStationWalk({ name: '台南大飯店', walk_basis: 'routed', walk_m: 888, walk_min: 12, group: 'hotel', rooms: 152, coord: [120.210644, 22.997276] }, 246);
  assert.equal(hotelTainan.walk_basis, 'est.');
  assert.equal(hotelTainan.walk_m, 320);
  assert.equal(hotelTainan.walk_min, 4);
  const shangri = reconcileStationWalk({ name: 'Shangri-La', walk_basis: 'routed', walk_m: 342, walk_min: 5, group: 'hotel', rooms: 330, coord: [120.2155, 22.9955] }, 300);
  assert.equal(shangri.walk_basis, 'routed', 'a normal detour stays routed');
  const picks = rankStays([hotelTainan, shangri, { name: '泊川', walk_basis: 'routed', walk_m: 787, walk_min: 11, group: 'hotel', rooms: 40, coord: [120.22, 22.99] }], { max: 2 });
  assert.equal(picks[0].name, '台南大飯店', 'the hotel opposite the main exit ranks first');
  assert.match(picks[0].why, /^about 4 min walk to /);
  assert.equal(picks[0].how[0].text, '320 m, estimated from the straight line (the routed walk went round the station)');
  // close places are left alone (a 2.5× detour over 100 m is normal)
  assert.equal(reconcileStationWalk({ walk_basis: 'routed', walk_m: 400, walk_min: 5 }, 120).walk_basis, 'routed');
});

test('HSR names and stations far from the centre', () => {
  assert.equal(hsrEnglishName('Tainan', 'Tainan'), 'Tainan HSR');
  assert.equal(hsrEnglishName(null, 'Taichung'), 'Taichung HSR');
  assert.equal(hsrEnglishName('Zuoying HSR Station', 'Zuoying'), 'Zuoying HSR Station');
  assert.equal(hsrEnglishName('Shin-Osaka Shinkansen', 'Osaka'), 'Shin-Osaka Shinkansen');
  const far = farFromCentreAdvice('Hualien', 2.3, 2, [121.6197, 23.9913], 'trip');
  assert.match(far, /2\.3 km \(about 35 min walk\) from Hualien's centre/);
  assert.match(far, /uw stay trip --near 121\.6197,23\.9913/);
  assert.equal(farFromCentreAdvice('Taipei', 0.6, 3, [121.5, 25.0]), null, 'close');
  assert.equal(farFromCentreAdvice('Tainan', 3, 0, [120.2, 23.0]), null, 'a pass-through stop');
});

test('far from the centre is measured where it means something (finish-taiwan-big readback)', () => {
  // Photon's numbers from that run: Hualien 1.3 km (outline 11.6 km), Taitung 4.8 km (23.4 km); the big
  // municipalities' points are city halls: Taipei 4.8 km (34.8 km), Taichung 4.9 km (112 km), Tainan 2.9 km (86 km).
  assert.match(farFromCentreAdvice('Hualien', 1.3, 2, [121.6068, 23.9821], 'trip', 11.6), /FAR FROM THE CENTRE: the station is 1\.3 km/);
  assert.match(farFromCentreAdvice('Taitung', 4.8, 2, [121.1457, 22.756], 'trip', 23.4), /FAR FROM THE CENTRE/);
  for (const [city, km, extent] of [['Taipei', 4.8, 34.8], ['Taichung', 4.9, 112.1], ['Tainan', 2.9, 86.3], ['Kaohsiung', 2.3, 1612]]) {
    assert.equal(farFromCentreAdvice(city, km, 2, [0, 0], 'trip', extent), null, city);
  }
  // A town station next to its centre stays quiet; unknown size keeps the town threshold.
  assert.equal(farFromCentreAdvice('Bologna', 1.1, 2, [11.34, 44.49], 'trip', 22), null);
  assert.match(farFromCentreAdvice('Porto', 2.4, 3, [-8.61, 41.15], 'trip', null), /FAR FROM THE CENTRE/);
});

test('handoff re-reads cited pages: a place its page does not name loses that source', async () => {
  const wikivoyageTaitung = 'Sleep\nMachiya Posong\nLa Pace\nWho Knows\nV-Hotel\nNaruwan Hotel';
  assert.equal(pageNamesPlace(wikivoyageTaitung, { name: 'Caesar Park Hotel Taitung (趣淘漫旅台東)', query: 'Caesar Park Hotel Taitung, Taitung', city: 'Taitung' }), false);
  assert.equal(pageNamesPlace(wikivoyageTaitung, { name: 'Naruwan Hotel', city: 'Taitung' }), true);
  assert.equal(pageNamesPlace('台南大飯店就在車站對面', { name: 'Hotel Tainan (台南大飯店)', city: 'Tainan' }), true);
  assert.equal(pageNamesPlace('Shangri-La Far Eastern Plaza Hotel, Tainan', { name: 'Shangri-La Far Eastern', city: 'Tainan' }), true);

  const c = checkHandoff({ schema: 'instafy.research@1', item: 'Taitung', kind: 'city',
    facts: [{ text: 'The station is a walk from town', source_url: 'https://gone.example/x', confidence: 'medium' }],
    places: [{ name: 'Caesar Park Hotel Taitung', kind: 'hotel', why: 'by the station', source_url: 'https://en.wikivoyage.org/wiki/Taitung' },
      { name: 'Naruwan Hotel', kind: 'hotel', why: 'downtown', source_url: 'https://en.wikivoyage.org/wiki/Taitung' },
      { name: 'Seaside park', kind: 'sight', source_url: 'https://blocked.example/' }],
    legs: [{ from: 'Taitung', to: 'Kaohsiung', mode: 'train', duration_min_range: [125, 190], source_url: 'https://en.wikivoyage.org/wiki/Taitung' }] });
  assert.ok(c.ok);
  const pages = { 'https://en.wikivoyage.org/wiki/Taitung': { status: 200, type: 'text/html', text: `<p>${wikivoyageTaitung.replace(/\n/g, '</p><p>')}</p>` },
    'https://gone.example/x': { status: 404, text: '' }, 'https://blocked.example/': { refused: 'blocked (HTTP 403)' } };
  const summary = await checkSources([c.item], { fetchPage: async (url) => pages[url] });
  assert.deepEqual({ read: summary.read, unreadable: summary.unreadable, mismatched: summary.mismatched, gone: summary.gone }, { read: 1, unreadable: 1, mismatched: 1, gone: 1 });
  const plan = planFromHandoff([c.item], 'trip');
  assert.ok(plan.unverified.includes('Taitung: Caesar Park Hotel Taitung (the cited page does not name it)'));
  assert.ok(plan.unverified.includes('Taitung: The station is a walk from town (its source page is gone)'));
  const caesar = plan.steps.find((s) => /Caesar Park/.test(s));
  assert.doesNotMatch(caesar, /source_url/, 'the mis-cited source is not carried to the map');
  assert.match(plan.steps.find((s) => /Naruwan/.test(s)), /source_url/);
  assert.ok(plan.steps.some((s) => /Seaside park/.test(s)), 'a page that refuses automated reads is not held against the place');
  assert.ok(plan.steps.some((s) => /Taitung → Kaohsiung \(train\): 2h05–3h10/.test(s)), 'a sourced range stays a range');
});

test('legs keep a sourced range as a range', () => {
  const dir = path.join(tmp, 'legs');
  assert.equal(spawnSync(process.execPath, [UW, 'new', dir, '--title', 'Trip', '--center', '121,23.5', '--zoom', '7'], { encoding: 'utf8' }).status, 0);
  const pt = (id, c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { id, name: id, kind: 'train_station' } });
  fs.writeFileSync(path.join(dir, 'data', 'stations.geojson'), JSON.stringify({ type: 'FeatureCollection', uw: { cmd: 'station' }, features: [pt('taitung', [121.122, 22.793]), pt('kaohsiung', [120.302, 22.639])] }));
  const r = spawnSync(process.execPath, [UW, 'legs', dir, '--layer', 'trip', '--stops', 'stations:taitung,stations:kaohsiung', '--modes', 'train',
    '--durations', '2h05–3h10', '--source', 'Wikivoyage', '--source-url', 'https://en.wikivoyage.org/wiki/Taitung', '--no-source-check', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const leg = JSON.parse(r.stdout).legs[0];
  assert.equal(leg.duration, '2h05–3h10');
  assert.equal(leg.duration_min, 125);
  assert.equal(leg.duration_max_min, 190);
});

test('a cluster lane is split into its stops; a city with no researched sights is called out (finish-taiwan-big)', async () => {
  const { isCluster, stopOf, parseRoute, legFor, stayMatches, legDuration } = await lib('cmd-handoff.mjs');
  assert.ok(isCluster('Hualien and Taitung') && isCluster('Kaohsiung / Tainan') && isCluster('Porto, Braga') && !isCluster('Taipei'));
  const raw = {
    schema: 'instafy.research@1', item: 'Hualien and Taitung', kind: 'city',
    places: [
      { name: 'Champ de Roses Hotel (玫瑰香榭飯店)', query: 'Champ de Roses Hotel, Hualien', kind: 'hotel', why: '3 min walk', source_url: 'https://champderoseshotel.com.tw/', stop: 'Hualien' },
      { name: 'Taroko Gorge', kind: 'sight', source_url: 'https://en.wikivoyage.org/wiki/Taroko_National_Park', stop: 'Hualien' },
      { name: 'Hotel Cham Cham', query: 'Hotel Cham Cham, Taitung', kind: 'hotel', why: 'next to the station' },
      { name: 'Joy Hotel', kind: 'hotel' },
    ],
    legs: [{ from: 'Hualien', to: 'Taitung', mode: 'train', duration_min_range: [100, 150], source_url: 'https://en.wikivoyage.org/wiki/Taitung', stop: 'Hualien' }],
  };
  const c = checkHandoff(raw);
  assert.ok(c.ok);
  assert.ok(c.errors.some((e) => /covers several stops, but 1 place\(s\) have no "stop"/.test(e)), c.errors.join('\n'));
  assert.equal(stopOf(c.item, c.item.places[0]), 'Hualien');
  assert.equal(stopOf(c.item, c.item.places[2]), 'Taitung', 'the city its query names');
  assert.equal(stopOf(c.item, c.item.places[3]), 'Hualien', 'a place that names no stop goes to the first city');
  const plan = planFromHandoff([c.item], 'trip');
  assert.ok(plan.steps.some((s) => s.startsWith('uw station trip --city "Hualien"')));
  assert.ok(plan.steps.some((s) => s.startsWith('uw station trip --city "Taitung"')), plan.steps.join('\n'));
  assert.ok(!plan.steps.some((s) => /hualien-and-taitung/.test(s)), 'never a stop called "hualien-and-taitung"');
  assert.ok(plan.steps.some((s) => /researched hotel Champ de Roses.*uw set trip stays:<its id>.*"researched":true/.test(s)));
  assert.ok(plan.notes.some((n) => /^Taitung: no sights researched/.test(n)), plan.notes.join('\n'));
  assert.ok(!plan.notes.some((n) => /^Hualien:/.test(n)));

  // --apply's pieces
  assert.deepEqual(parseRoute('Taipei:3, Hualien:2,Taipei:1').map((r) => [r.id, r.nights]), [['taipei', 3], ['hualien', 2], ['taipei', 1]]);
  assert.throws(() => parseRoute('Taipei,Hualien'), /<City>:<nights>/);
  assert.equal(legDuration(legFor([c.item], 'Hualien', 'Taitung')), '1h40–2h30');
  assert.equal(legFor([c.item], 'Taitung', 'Hualien')?.from, 'Hualien', 'the same line either way');
  assert.equal(legFor([c.item], 'Taipei', 'Hualien'), null);
  // the register's Chinese-named pick with the hotel's own website, or its English name, is the researched hotel
  assert.ok(stayMatches({ name: '玫瑰香榭飯店' }, c.item.places[0], 'Hualien'));
  assert.ok(stayMatches({ name: '香榭', name_en: 'Champ de Roses Hotel' }, c.item.places[0], 'Hualien'));
  assert.ok(!stayMatches({ name: '花蓮翰品酒店', name_en: 'Chateau de Chine' }, c.item.places[0], 'Hualien'));
});

test('handoff --apply refuses to start without a route and a start date', () => {
  const dir = path.join(tmp, 'handoff-apply');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'porto.json'), JSON.stringify({ schema: 'instafy.research@1', item: 'Porto', kind: 'city' }));
  const r = spawnSync(process.execPath, [UW, 'handoff', dir, '--site', path.join(tmp, 'site'), '--apply', '--start', '2027-05-07', '--no-source-check'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--route needs at least two stops/);
});
