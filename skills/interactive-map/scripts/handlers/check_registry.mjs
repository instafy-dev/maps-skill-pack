#!/usr/bin/env node
// Intent handler: check_registry {ref, name?, lnglat?, refresh?}
// Looks an item up in Taiwan's official lodging registers (data.gov.tw 7780 + Taipei 135464) and emits claims:
// licence (ok | uncertain | not_found), registered_rooms, filed_price_min, filed_price_max (filed rates, not live prices).
// Run by uw host (one JSON object on stdin, NDJSON on stdout). Never writes site files.
import { readInput, progress, records, done, fail, log, siteView, findFeature, runHandler } from '../lib/handler-io.mjs';
import { makeAdapterCtx } from '../lib/cmd-adapter.mjs';
import { lookup, claimsFor, ATTRIBUTION, LABEL, NATIONAL, TAIPEI } from '../adapters/tw-hotels.mjs';

runHandler(async () => {
  if (process.env.UW_WARM) { // uw host warms the dataset cache at start so the first click is fast
    const ctx = makeAdapterCtx({ name: 'tw-hotels', log, observedBy: 'uw-host' });
    await lookup(ctx, { props: { name: 'warm-up' }, lnglat: [121.5, 25.05] });
    return done('warm');
  }
  const input = await readInput();
  const params = input?.intent?.params || {};
  const ref = String(params.ref || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:\S{1,120}$/.test(ref)) fail('invalid', 'params.ref must be "<layer>:<id>"');
  const site = siteView(input);
  const hit = findFeature(site, ref);
  const lnglat = Array.isArray(params.lnglat) && params.lnglat.length === 2 && params.lnglat.every(Number.isFinite) ? params.lnglat : null;
  if (!hit && !params.name && !lnglat) fail('not_found', `${ref} is not on this map and no name or lnglat was given`);
  const props = hit ? hit.feature.properties : { name: params.name };
  // "check again" re-matches against the cached registers (≤ 24 h old); it never re-downloads 5 MB per tap. The
  // dataset's own date says how fresh the answer is.
  const ctx = makeAdapterCtx({ name: 'tw-hotels', refresh: false, log, observedBy: 'uw-host' });
  const steps = {
    1: () => progress(1, 2, 'Loading Taiwan hotel database (data.gov.tw 7780)', NATIONAL.id),
    2: () => progress(2, 2, 'Matching against the Taipei register (135464)', TAIPEI.id),
  };
  const { match } = await lookup(ctx, { feature: hit?.feature, props, lnglat: hit ? undefined : lnglat, onStep: (n) => steps[n]?.() });
  const list = claimsFor(ref, match, { observedBy: 'uw-host' });
  records(list, [ATTRIBUTION]);
  const who = props.name_en || props.name || ref;
  if (match.status === 'registered') done(`${who}: ${LABEL[match.class || 'hotel']} ${match.licence_id || ''} (match ${match.confidence}: ${match.by.join('+')})`.trim());
  else if (match.status === 'uncertain') done(`${who}: possibly ${match.licence_id || match.candidate} (match ${match.confidence}); check before relying on it`);
  else done(`${who}: not found in the national or Taipei register`);
});
