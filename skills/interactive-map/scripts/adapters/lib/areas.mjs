// Where each dataset adapter answers, what it gives the generic commands, and the credit its licence requires.
// Generic commands (geocode, add-point, places, stay, validate) never test for a country: they ask
// adapterFor('<capability>', point) and fall back to OpenStreetMap when no adapter covers the point. A new country's
// open data is one adapter module (scripts/adapters/<name>.mjs) plus one entry here; nothing else changes.
//
// Capabilities:
//   lodging-register  official lodging registers (name search with coordinates; licensed hotels and B&Bs near a point)
//   metro-stations    every station of a metro network with its entrances
//   night-markets     official night-market lists
//
// Each entry: name (the adapter), provides, label, bbox [w, s, e, n] (a coarse box: callers also limit the distance to
// their point), names (place names that put a query in this area when no point is known), credit (the attribution
// string the data's licence requires, how to recognise it, and how to tell the adapter's data is on a map).
const OGDL_TW = /政府資料開放授權|OGDL/i;
const TAIWAN_NAMES = /taiwan|taipei|taichung|tainan|kaohsiung|hualien|taitung|hsinchu|keelung|yilan|[臺台]灣|[臺台]北|[臺台]中|[臺台]南|高雄|花蓮/i;
const TW_DATA = { propPrefix: 'tw_', recordSource: /^data\.(gov\.tw|taipei)\// };

export const ADAPTER_AREAS = [
  {
    name: 'tw-hotels', provides: ['lodging-register'],
    label: "Taiwan's lodging registers (data.gov.tw 7780 + Taipei 135464)",
    bbox: [118.1, 21.8, 122.1, 26.4], names: TAIWAN_NAMES,
    credit: { re: OGDL_TW, text: '旅館資料：交通部觀光署、臺北市政府 (data.gov.tw，政府資料開放授權條款第1版)', marks: TW_DATA },
  },
  {
    name: 'tw-metro', provides: ['metro-stations'],
    label: 'Taipei Metro open data (data.gov.tw 131734, 128428)',
    bbox: [119.2, 21.8, 122.2, 25.4], names: /taipei|new taipei|[臺台]北|新北/i,
    credit: { re: OGDL_TW, text: '捷運車站資料：臺北大眾捷運股份有限公司 (data.gov.tw，政府資料開放授權條款第1版)', marks: TW_DATA },
  },
  {
    name: 'tw-night-markets', provides: ['night-markets'],
    label: 'Taipei night markets (data.gov.tw)',
    bbox: [121.3, 24.9, 121.7, 25.3], names: /taipei|[臺台]北/i,
    credit: { re: OGDL_TW, text: '夜市資料：臺北市政府市場處 (data.gov.tw，政府資料開放授權條款第1版)', marks: TW_DATA },
  },
];

const inBox = (c, [w, s, e, n]) => Array.isArray(c) && c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n;

/** The adapter that provides `capability` at a [lng, lat] point, or null (then OpenStreetMap). */
export function adapterFor(capability, point) {
  return ADAPTER_AREAS.find((a) => a.provides.includes(capability) && inBox(point, a.bbox)) || null;
}

/** The adapter that provides `capability` for a place named in text ("Lore Hotel, Taipei"), or null. */
export function adapterNamedIn(capability, text) {
  return ADAPTER_AREAS.find((a) => a.provides.includes(capability) && a.names.test(String(text || ''))) || null;
}

/** Every adapter whose area contains the point (for `uw adapter list --at`). */
export function adaptersAt(point) {
  return ADAPTER_AREAS.filter((a) => inBox(point, a.bbox));
}

/** The adapter for `capability` in the area a site or command works in: --near first, else the site's view centre or
 *  bounds, else (a site with no view yet) a place named in the query or the site's title. */
export function adapterForArea(capability, site, near, text = '') {
  if (near) return adapterFor(capability, near);
  const v = site?.config?.view;
  // the starter's world view (no bounds, zoom < 4) says nothing about the area
  if (!v || (!Array.isArray(v.bounds) && !(Number(v.zoom) >= 4))) return adapterNamedIn(capability, `${text} ${site?.config?.title || ''}`);
  if (Array.isArray(v.center) && !(v.center[0] === 0 && v.center[1] === 0)) {
    const hit = adapterFor(capability, v.center);
    if (hit) return hit;
  }
  const b = v.bounds;
  if (Array.isArray(b) && b.length === 2) return adapterFor(capability, [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]);
  return null;
}

/** The credits the validator checks, one per licence (adapters under the same licence share one check). */
export function adapterCredits() {
  const byLicence = new Map();
  for (const a of ADAPTER_AREAS) {
    const key = `${a.credit.re.source}|${a.credit.marks.propPrefix || ''}|${a.credit.marks.recordSource?.source || ''}`;
    if (!byLicence.has(key)) byLicence.set(key, { names: [], texts: [], re: a.credit.re, marks: a.credit.marks });
    byLicence.get(key).names.push(a.name);
    byLicence.get(key).texts.push(a.credit.text);
  }
  return [...byLicence.values()];
}
