// The "places" lookup chain (lookup-providers.json): named OpenStreetMap objects of some kinds around points or in an
// area. Overpass first (the full data); while it cannot answer, a reverse place search per point and tag (names and
// positions only, at most 50 per point: a PARTIAL answer). Used by `places` and `stay`.
import { ask, fetchJSON, isSkip, overpass, withReserve } from './net.mjs';

/** One reverse lookup: the named objects with one osm_tag ("railway:station") within radiusM of a point, nearest
 *  first, at most `limit` (the service's cap). */
async function reverseOne(p, [lng, lat], { radiusM, tag, limit = 50 }) {
  const u = `${p.base}/reverse?lon=${lng}&lat=${lat}&radius=${(radiusM / 1000).toFixed(3)}&limit=${limit}&osm_tag=${encodeURIComponent(tag)}`;
  const fc = await fetchJSON(u, { label: p.label, retries: 1, timeoutMs: p.timeout_ms });
  return fc?.features || [];
}

export const PLACES_PROTOCOLS = {
  overpass: {
    accepts: (req) => !!req.query,
    async lookup(req) {
      const run = () => overpass(req.query, { timeoutS: req.timeoutS ?? 60 });
      // a later provider can answer this request: keep some of the time back for it
      const data = req.reverse ? await withReserve(req.reserveMs ?? 15000, run) : await run();
      return { results: data?.elements || [], meta: { cached: !!data?._cached } };
    },
  },
  'photon-reverse': {
    accepts: (req) => !!req.reverse?.points?.length && !!req.reverse?.tags?.length,
    // one lookup per point and tag, merged by OSM id, shaped like Overpass elements (tags: the one asked + name)
    async lookup(req, p) {
      const { points, radiusM, tags } = req.reverse;
      const els = new Map();
      const notes = [];
      let capped = 0;
      outer: for (const c of points) {
        for (const { tag, kind } of tags) {
          let fs;
          try { fs = await reverseOne(p, c, { radiusM, tag }); }
          catch (e) {
            // some places found already: keep them (partial), say where it stopped
            if (isSkip(e) && els.size) { notes.push(`stopped early: ${e.why || e.message}`); break outer; }
            throw e;
          }
          if (fs.length >= 50) capped++;
          for (const f of fs) {
            const pr = f.properties || {}, [lon, lat] = f.geometry?.coordinates || [];
            if (lat == null || !pr.osm_id) continue;
            const type = { N: 'node', W: 'way', R: 'relation' }[pr.osm_type] || 'node';
            const [tk, tv] = tag.split(':');
            const t = { [tk]: tv, ...(pr.name ? { name: pr.name } : {}), ...(pr.street ? { 'addr:street': pr.street } : {}), ...(pr.housenumber ? { 'addr:housenumber': pr.housenumber } : {}) };
            els.set(`${type}${pr.osm_id}`, { type, id: pr.osm_id, lat, lon, tags: t, ...(kind ? { _kind: kind } : {}) });
          }
        }
      }
      if (capped) notes.push(`${capped} lookup(s) hit the 50-place cap: counts there are "at least"`);
      return { results: [...els.values()], partial: true, notes };
    },
  },
};

/**
 * Places from the chain. req: { query (Overpass QL), timeoutS, reserveMs, reverse?: { points: [[lng,lat]], radiusM,
 * tags: [{ tag: "amenity:cafe", kind }] } } (`reverse` only when a reverse search can answer the same question).
 * Resolves { status: ok | partial | not_found, elements, provider, label, notes, fallbackFor, cached }; none could answer:
 * a SkipError (exit 4, unavailable).
 */
export async function placesSearch(req) {
  const r = await ask('places', req, PLACES_PROTOCOLS);
  const fallbackFor = [...new Set(r.attempts.filter((a) => a.outcome === 'unavailable' || a.outcome === 'skipped_open').map((a) => `${a.label} (${a.detail || 'unavailable'})`))];
  return { status: r.status, elements: r.results, provider: r.provider, label: r.label, notes: r.notes || [], fallbackFor, cached: !!r.meta?.cached };
}
