// map-pack engine: link-outs (ENGINE-SPEC-v0.2 §5). Kit-owned file.
// Pure URL builders: no network call, nothing from Google or Apple is embedded. Every link opens in a new tab.
import { round6, isIOS } from './util.js';

export const LINK_LABELS = { google: 'Google Maps ↗', streetview: 'Street View ↗', apple: 'Apple Maps ↗', lookaround: 'Look Around ↗',
  directions: 'Transit directions ↗', panoramax: 'Street photo ↗' };
export const DEFAULT_SHOW = ['streetview', 'google', 'directions', 'lookaround'];
const ll = (c) => `${round6(c[1])},${round6(c[0])}`; // lat,lng
const isPair = (x) => Array.isArray(x) && x.length >= 2 && x.every((n) => typeof n === 'number' && isFinite(n));
const appleDevice = () => /iPhone|iPad|Macintosh/.test(navigator.userAgent) || isIOS();

/**
 * Build the link-out list for one feature.
 * @param {object} p feature properties   @param {[number,number]} at feature point [lng,lat]
 * @param {object} o { show, lookaround, directions: {label, from: [lng,lat]|null, mode}, photo }
 */
export function buildLinks(p, at, o = {}) {
  if (!isPair(at)) return [];
  const out = [];
  const name = typeof p.name_en === 'string' && p.name_en ? p.name_en : typeof p.name === 'string' ? p.name : '';
  const where = typeof p.address_en === 'string' ? p.address_en : typeof p.address === 'string' ? p.address : typeof p.area === 'string' ? p.area : '';
  const view = isPair(p.sv_viewpoint) ? p.sv_viewpoint : at;
  const heading = typeof p.sv_heading === 'number' && isFinite(p.sv_heading) ? Math.round(((p.sv_heading % 360) + 360) % 360) : null;
  for (const kind of o.show || DEFAULT_SHOW) {
    let url = null, label = LINK_LABELS[kind];
    if (kind === 'google') {
      const q = name ? `${name} ${where}`.trim() : ll(at);
      url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
      if (typeof p.place_id === 'string' && /^[\w-]{6,300}$/.test(p.place_id)) url += `&query_place_id=${encodeURIComponent(p.place_id)}`;
    } else if (kind === 'streetview') {
      url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll(view)}${heading != null ? `&heading=${heading}` : ''}&pitch=0&fov=80`;
    } else if (kind === 'apple') {
      url = `https://maps.apple.com/?q=${encodeURIComponent(name || 'Pin')}&ll=${ll(at)}`;
    } else if (kind === 'lookaround') {
      if (!(o.lookaround === true || (o.lookaround !== false && appleDevice()))) continue;
      url = `https://maps.apple.com/look-around?coordinate=${ll(view)}${heading != null ? `&heading=${heading}` : ''}`;
    } else if (kind === 'directions') {
      const d = o.directions || {};
      const from = isPair(d.from) ? d.from : null;
      if (from && Math.abs(from[0] - at[0]) < 1e-7 && Math.abs(from[1] - at[1]) < 1e-7) continue; // directions to itself
      const mode = ['transit', 'walking', 'driving', 'bicycling'].includes(d.mode) ? d.mode : 'transit';
      url = `https://www.google.com/maps/dir/?api=1&destination=${ll(at)}&travelmode=${mode}${from ? `&origin=${ll(from)}` : ''}`;
      label = typeof d.label === 'string' && d.label ? d.label : mode === 'transit' ? LINK_LABELS.directions : `${mode[0].toUpperCase()}${mode.slice(1)} directions ↗`;
    } else if (kind === 'panoramax') {
      const u = o.photo?.viewer_url;
      if (typeof u !== 'string' || !/^https:\/\//.test(u)) continue;
      url = u;
    } else continue;
    out.push({ kind, label, url });
  }
  return out;
}
