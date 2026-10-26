// Travel times as a page states them, for checking a leg's duration against the page it cites (`uw legs`).
// Pure; exported for the tests.

const NUM = '(\\d+(?:[.,]\\d+)?)';
const H = '(?:hours?|hrs?|h|時間|小時|小时|시간)';
const M = '(?:minutes?|mins?|min|m|分鐘|分钟|分|분)';
// on its own a bare "m" is metres ("500 m"), so a time in minutes alone needs its word
const MIN = '(?:minutes?|mins?|min|分鐘|分钟|分|분)';
const RANGE = '\\s*(?:to|-|–|—|~|〜|or)\\s*';
const ABOUT = /\b(?:half an hour|an hour and a half|an hour)\b/gi;

const num = (s) => Number(String(s).replace(',', '.'));

/** Every travel time a page's text states, in minutes: `{min, max}` (max equals min for a single time). "about 3
 *  hours" → 180, "2 to 3 hours" → 120–180, "3h45" / "3 hr 45 min" → 225, "90 minutes" → 90, "2½ hours" → 150,
 *  "3小時" / "3時間45分" → 180 / 225. Clock times ("8:40") are not durations. */
export function pageDurations(text) {
  // "2½" first: NFKC turns ½ into "1⁄2"
  const page = String(text || '').replace(/(\d)\s*½/g, '$1.5').replace(/½/g, '0.5').normalize('NFKC').replace(/ /g, ' ');
  const found = [];
  const add = (a, b = a) => { if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b >= a && b <= 72 * 60) found.push({ min: Math.round(a), max: Math.round(b) }); };
  let rest = page;
  const take = (re, fn) => { rest = rest.replace(re, (...m) => { fn(m); return ' '; }); };
  // ranges first, so "2 to 3 hours" is not read as "3 hours"
  take(new RegExp(`${NUM}${RANGE}${NUM}\\s*${H}(?![a-z])`, 'gi'), (m) => add(num(m[1]) * 60, num(m[2]) * 60));
  take(new RegExp(`(\\d+)\\s*${H}\\s*(?:and\\s*)?(\\d{1,2})\\s*${M}?${RANGE}(\\d+)\\s*${H}\\s*(?:and\\s*)?(\\d{1,2})\\s*${M}?(?![a-z])`, 'gi'),
    (m) => add(Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])));
  take(new RegExp(`(\\d+)${RANGE}(\\d+)\\s*${MIN}(?![a-z])`, 'gi'), (m) => add(Number(m[1]), Number(m[2])));
  take(new RegExp(`(\\d+)\\s*${H}\\s*(?:and\\s*)?(\\d{1,2})\\s*${M}?(?![a-z\\d])`, 'gi'), (m) => add(Number(m[1]) * 60 + Number(m[2])));
  take(new RegExp(`${NUM}\\s*${H}(?![a-z])`, 'gi'), (m) => add(num(m[1]) * 60));
  take(new RegExp(`(\\d+)\\s*${MIN}(?![a-z])`, 'gi'), (m) => add(Number(m[1])));
  for (const m of rest.matchAll(ABOUT)) {
    const w = m[0].toLowerCase();
    add(w === 'half an hour' ? 30 : w === 'an hour' ? 60 : 90);
  }
  return found;
}

/** Does the page state this duration? A single time matches a stated time within `tolerance` minutes; a range
 *  (`max` > `min`) matches a stated range with both ends within it, or both ends stated as times. A time inside a
 *  stated range does not match: a range is copied as a range, never as a midpoint. */
export function pageStatesDuration(text, min, max = min, tolerance = 5) {
  if (!Number.isFinite(min)) return false;
  const near = (a, b) => Math.abs(a - b) <= tolerance;
  const stated = pageDurations(text);
  if (max === min || !Number.isFinite(max)) return stated.some((d) => d.max === d.min && near(d.min, min));
  if (stated.some((d) => near(d.min, min) && near(d.max, max))) return true;
  const singles = stated.flatMap((d) => (d.max === d.min ? [d.min] : []));
  return singles.some((v) => near(v, min)) && singles.some((v) => near(v, max));
}

/** "about 3h", "2h–3h": the times a page states, for telling the agent what to copy instead. */
export function describeDurations(found, fmt) {
  const uniq = [...new Map(found.map((d) => [`${d.min}-${d.max}`, d])).values()].slice(0, 4);
  return uniq.map((d) => (d.max > d.min ? `${fmt(d.min)}–${fmt(d.max)}` : fmt(d.min))).join(', ');
}
