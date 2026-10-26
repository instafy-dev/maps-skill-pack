// The routing and data lookup chains (lookup-providers.json): `route` and `walk-table` (OSRM-style servers),
// `isochrone` (Valhalla-style), `transit` (MOTIS-style journey planners), `air` (Open-Meteo-style). This file says
// how each protocol is asked; who is asked, in what order, is data. A provider that is down is skipped for its
// cooldown by every uw command, and none left = exit 4 (unavailable), never "no route".
import { ask, cacheFor, fetchJSON } from './net.mjs';

const OSRM_PROFILES = { foot: ['routed-foot', 'foot'], bike: ['routed-bike', 'bike'], car: ['routed-car', 'driving'] };
export const OSRM_MODES = Object.keys(OSRM_PROFILES);

export const ROUTING_PROTOCOLS = {
  osrm: {
    accepts: (req) => !!OSRM_PROFILES[req.mode || 'foot'],
    async lookup({ service, mode = 'foot', coords, query = '', retries, timeoutMs }, p) {
      const [prefix, profile] = OSRM_PROFILES[mode];
      const url = `${p.base}/${prefix}/${service}/v1/${profile}/${coords.map((c) => `${c[0]},${c[1]}`).join(';')}${query ? `?${query}` : ''}`;
      return [await fetchJSON(url, { label: p.label, timeoutMs: timeoutMs ?? p.timeout_ms, ...cacheFor(p, 7 * 864e5), ...(retries != null ? { retries } : {}) })];
    },
  },
  valhalla: {
    async lookup({ body }, p) {
      return [await fetchJSON(`${p.base}/isochrone?json=${encodeURIComponent(JSON.stringify(body))}`, { label: p.label, timeoutMs: p.timeout_ms, ...cacheFor(p, 7 * 864e5) })];
    },
  },
  motis: {
    accepts: (req, p) => !!(req.base || p.base),
    async lookup({ base, params }, p) {
      const root = base || p.base;
      const q = new URL(`${root}/api/v5/plan`);
      for (const [k, v] of Object.entries(params)) q.searchParams.set(k, v);
      const plan = await fetchJSON(q.toString(), { label: new URL(root).host, timeoutMs: p.timeout_ms, ...cacheFor(p, 864e5) });
      return [{ plan, url: q.toString(), host: new URL(root).host }];
    },
  },
  'open-meteo': {
    async lookup({ params, cacheMaxAgeMs }, p) {
      const u = new URL(`${p.base}/v1/air-quality`);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      const policy = cacheFor(p, cacheMaxAgeMs);
      // the caller's age limit, never longer than the provider's terms allow
      return [await fetchJSON(u.toString(), { label: p.label, timeoutMs: p.timeout_ms, ...policy, ...(policy.cache && cacheMaxAgeMs ? { cacheMaxAgeMs: Math.min(cacheMaxAgeMs, policy.cacheMaxAgeMs ?? cacheMaxAgeMs) } : {}) })];
    },
  },
};

const first = async (capability, req, opts) => {
  const r = await ask(capability, req, ROUTING_PROTOCOLS, opts);
  return { data: r.results[0], label: r.label, provider: r.provider };
};

/** A route through `coords` ([lng,lat]…) for mode foot | bike | car: the server's answer ({ code, routes, … }). */
export async function routeLookup(coords, { mode = 'foot', query = 'overview=full&geometries=geojson&steps=false' } = {}) {
  return first('route', { service: 'route', mode, coords, query });
}
/** Walking (or riding) times from `from` to each of `to`: the server's table answer ({ code, durations, distances }). */
export async function walkTable(from, to, { mode = 'foot', retries, timeoutMs } = {}) {
  return (await first('walk-table', { service: 'table', mode, coords: [from, ...to], query: 'sources=0&annotations=duration,distance', retries, timeoutMs })).data;
}
/** Isochrone polygons for one Valhalla-style request body. */
export async function isochroneLookup(body) {
  return first('isochrone', { body });
}
/** A journey plan: { plan, url, host } (`base` overrides the declared planner for this call; health is kept per base). */
export async function transitLookup(params, { base = null } = {}) {
  return (await first('transit', { base, params }, base ? { where: { base } } : {})).data;
}
/** Air-quality time series for the params' locations. */
export async function airLookup(params, { cacheMaxAgeMs } = {}) {
  return first('air', { params, cacheMaxAgeMs });
}
