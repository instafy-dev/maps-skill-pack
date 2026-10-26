#!/usr/bin/env node
// Intent handler: find_hotels_nearby {at:[lng,lat], radius_m=600, max=15, refresh?}
// Registered lodging (data.gov.tw 7780, with coordinates, ServiceStatus open) near a point, nearest first. Emits one
// "item" per hotel plus claims (licence, filed_price_min/max: filed rates, not live prices), in batches of 5 so pins
// stream in. Skips hotels already matched to items on the map (same tw_hotel_id). Never writes site files.
import fs from 'node:fs';
import path from 'node:path';
import { readInput, progress, records, done, fail, log, siteView, runHandler } from '../lib/handler-io.mjs';
import { makeAdapterCtx } from '../lib/cmd-adapter.mjs';
import { nearby, ATTRIBUTION, NATIONAL, LABEL, VERSION } from '../adapters/tw-hotels.mjs';
import { rid } from '../lib/records.mjs';
import { hasLatin } from '../adapters/lib/twnorm.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

runHandler(async () => {
  if (process.env.UW_WARM) { // uw host warms the dataset cache at start so the first click is fast
    const ctx = makeAdapterCtx({ name: 'tw-hotels', log, observedBy: 'uw-host' });
    await nearby(ctx, { at: [121.5, 25.05], radius_m: 100, max: 1 });
    return done('warm');
  }
  const input = await readInput();
  const p = input?.intent?.params || {};
  const at = p.at;
  if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite) || Math.abs(at[0]) > 180 || Math.abs(at[1]) > 90) fail('invalid', 'params.at must be [lng, lat]');
  const radius = Math.max(100, Math.min(2000, Number(p.radius_m) || 600));
  const max = Math.max(1, Math.min(30, Number(p.max) || 15));
  const layer = input?.bound?.target?.layer || 'nearby_hotels';
  const site = siteView(input);
  // tw_hotel_id already on the map (options matched by the tw-hotels adapter or check_registry)
  const skip = new Set();
  try {
    for (const f of fs.readdirSync(path.join(site.dir, 'data'))) {
      if (!f.endsWith('.geojson')) continue;
      const fc = JSON.parse(fs.readFileSync(path.join(site.dir, 'data', f), 'utf8'));
      for (const x of fc.features || []) if (x?.properties?.tw_hotel_id) skip.add(x.properties.tw_hotel_id);
    }
  } catch {}
  const ctx = makeAdapterCtx({ name: 'tw-hotels', refresh: false, log, observedBy: 'uw-host' }); // cached registers (≤ 24 h)
  const res = await nearby(ctx, { at, radius_m: radius, max, skip, onStep: (n) => { if (n === 1) progress(1, 2, 'Loading Taiwan hotel database (data.gov.tw 7780)', NATIONAL.id); } });
  progress(2, 2, `Registered hotels within ${radius} m: ${res.total} found`, NATIONAL.id);
  const now = new Date().toISOString();
  const prov = { source: NATIONAL.id, source_label: NATIONAL.label, lane: 'open', url: NATIONAL.page, observed_at: now, observed_by: 'uw-host',
    as_of: res.national_as_of || undefined, ttl_s: 0, refresh_days: 45, class: 'stored', license: { store: 'full', attribution: NATIONAL.licenceAttribution }, adapter: VERSION };
  const clean = (o) => JSON.parse(JSON.stringify(o));
  let batch = [];
  let n = 0;
  for (const it of res.items) {
    const r = it.row;
    const iid = rid('tw7780', String(r.id).replace(/^Hotel_/, ''));
    const ref = `${layer}:${iid}`;
    const en = r.alt.find(hasLatin) || null;
    batch.push(clean({ type: 'item', iid, layer, kind: 'lodging', name: { local: r.name.slice(0, 120), ...(en ? { en: en.slice(0, 120) } : {}) },
      geo: { lng: r.lng, lat: r.lat }, keys: { tw_hotel_id: r.id, ...(r.lic ? { tw_licence_id: r.lic } : {}) },
      props: { tw_rooms: r.rooms, tw_class: it.cls.zh, licence_class: it.cls.key || null, distance_m: it.dist, tw_price_min: r.pmin, tw_price_max: r.pmax, address: (r.address || '').slice(0, 140) || null, emoji: '🏨',
        ...(en ? {} : { name_note: 'No English name in the register' }) }, prov }));
    if (r.lic) batch.push(clean({ type: 'claim', cid: rid('clm_tw', iid, 'licence'), ref, attr: 'licence', value: r.lic, status: 'ok', label: 'Hotel licence',
      basis: 'registry', confidence: 'high', match: { confidence: 'high', by: ['id'], candidate: r.name.slice(0, 120) }, prov }));
    if (r.rooms != null) batch.push(clean({ type: 'claim', cid: rid('clm_tw', iid, 'rooms'), ref, attr: 'registered_rooms', value: r.rooms, unit: 'rooms', label: 'Registered rooms',
      basis: 'registry', confidence: 'high', prov }));
    if (r.pmin != null) batch.push(clean({ type: 'claim', cid: rid('clm_tw', iid, 'pmin'), ref, attr: 'filed_price_min', value: r.pmin, unit: 'TWD', label: 'Filed min rate',
      note: 'filed min rate, not a live price', basis: 'filed', confidence: 'high', prov }));
    if (r.pmax != null) batch.push(clean({ type: 'claim', cid: rid('clm_tw', iid, 'pmax'), ref, attr: 'filed_price_max', value: r.pmax, unit: 'TWD', label: 'Filed max rate',
      note: 'filed max rate, not a live price', basis: 'filed', confidence: 'high', prov }));
    n++;
    if (n % 5 === 0) { records(batch, [ATTRIBUTION]); batch = []; await sleep(150); }
  }
  records(batch, [ATTRIBUTION]);
  const shown = res.items.length;
  done(`${shown} registered hotel${shown === 1 ? '' : 's'} within ${radius} m${res.total > shown ? ` (nearest ${shown} of ${res.total})` : ''}` +
    `${res.skipped ? `; ${res.skipped} already on the map skipped` : ''} · data.gov.tw 7780 as of ${res.national_as_of}`);
});
