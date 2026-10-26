// Taiwan text normalisation for matching: fullwidth → halfwidth, 台 → 臺, Chinese numerals, addresses, phones, names.

export function halfwidth(s) {
  return String(s ?? '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}

const ZH_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
// "十二" → 12, "二十" → 20, "三" → 3 (up to 99, enough for 段/巷/弄/號 in practice)
export function zhNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零〇一二兩三四五六七八九十]+$/.test(s)) return null;
  if (!s.includes('十')) return Number([...s].map((c) => ZH_DIGIT[c]).join(''));
  const [a, b] = s.split('十');
  return (a ? ZH_DIGIT[a] : 1) * 10 + (b ? ZH_DIGIT[b] : 0);
}

export function normText(s) {
  return halfwidth(s).replace(/台/g, '臺').replace(/\s+/g, '').trim();
}

// Address → { city, district, road, section, lane, alley, number }. Accepts registry style
// ("103臺北市大同區延平北路三段4號6樓") and Photon style ("延平北路三段 4號, 大同區, 臺北市, 臺灣").
export function parseAddress(raw) {
  if (!raw) return null;
  let s = halfwidth(raw).replace(/台/g, '臺');
  // Photon style: comma-separated, most specific first → keep the parts that are not just city/district/country
  if (/,/.test(s)) {
    const parts = s.split(/\s*,\s*/).filter(Boolean);
    const city = parts.find((p) => /^..[市縣]$/.test(p));
    const district = parts.find((p) => /^.{1,3}[區鄉鎮]$/.test(p));
    const rest = parts.filter((p) => p !== city && p !== district && !/^(臺灣|Taiwan|中華民國)$/.test(p) && !/^\d{3,6}$/.test(p));
    s = (city || '') + (district || '') + rest.join('');
  }
  s = s.replace(/\s+/g, '');
  // Chinese numerals before 段/巷/弄/號
  s = s.replace(/([零〇一二兩三四五六七八九十]+)(段|巷|弄|號|樓)/g, (m, n, u) => { const v = zhNumber(n); return v == null ? m : v + u; });
  const out = { city: null, district: null, road: null, section: null, lane: null, alley: null, number: null };
  s = s.replace(/^\d{3,6}/, '').replace(/^臺灣/, '');
  let m;
  if ((m = s.match(/^(..[市縣])/))) { out.city = m[1]; s = s.slice(m[1].length); }
  if ((m = s.match(/^(.{1,3}?[區鄉鎮])(?=.)/)) && !/[路街道]/.test(m[1])) { out.district = m[1]; s = s.slice(m[1].length); }
  if ((m = s.match(/^(.*?[^\d](?:大道|路|街))/))) { out.road = m[1]; s = s.slice(m[1].length); }
  if ((m = s.match(/^(\d+)段/))) { out.section = Number(m[1]); s = s.slice(m[0].length); }
  if ((m = s.match(/^(\d+)巷/))) { out.lane = Number(m[1]); s = s.slice(m[0].length); }
  if ((m = s.match(/^(\d+)弄/))) { out.alley = Number(m[1]); s = s.slice(m[0].length); }
  if ((m = s.match(/^(\d+)(?:之(\d+))?(?:號|$|[^\d段巷弄])/))) out.number = Number(m[1]);
  if (!out.road) return { ...out, raw };
  return out;
}

// Same road + section + number (lane/alley must agree when both sides have them).
export function sameAddress(a, b) {
  if (!a || !b || !a.road || !b.road || a.number == null || b.number == null) return false;
  if (a.road !== b.road || a.number !== b.number) return false;
  if ((a.section ?? null) !== (b.section ?? null)) return false;
  if (a.lane != null && b.lane != null && a.lane !== b.lane) return false;
  if (a.alley != null && b.alley != null && a.alley !== b.alley) return false;
  return true;
}
export function addressKey(a) {
  if (!a?.road || a.number == null) return null;
  return [a.road, a.section ?? '', a.lane ?? '', a.alley ?? '', a.number].join('|');
}
export function formatAddress(a) {
  if (!a?.road) return '';
  return `${a.road}${a.section ? a.section + '段' : ''}${a.lane ? a.lane + '巷' : ''}${a.alley ? a.alley + '弄' : ''}${a.number != null ? a.number + '號' : ''}`;
}

// Phones → digits, +886 → 0, extension dropped. A field may hold several numbers.
export function normPhones(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    const s0 = typeof item === 'object' && item ? item.Tel || item.tel || item.Number || '' : item;
    for (const part of halfwidth(String(s0 ?? '')).split(/[、,;/／]|或/)) {
      let s = part.replace(/(#|轉|ext\.?|分機).*$/i, '');
      s = s.replace(/^\s*\+?886\s*\(?0?\)?/, '0').replace(/\D/g, '');
      if (s.length >= 8) out.push(s.startsWith('0') || s.length > 9 ? s : '02' + s);
    }
  }
  return [...new Set(out)];
}

const STRIP = ['大飯店', '旅店', '酒店', '飯店', '旅館', '商旅', '公寓', '行旅', '文旅', '民宿', '精品', 'boutique', 'hotel', 'hostel', 'inn', 'the', 'taipei', '臺北', '台北', '館'];
// Name → comparable core: lowercase, halfwidth, no punctuation, generic words stripped, branch suffix "...館" dropped.
export function normName(raw) {
  let s = halfwidth(raw || '').toLowerCase().replace(/台/g, '臺');
  s = s.replace(/[()（）〈〉「」『』【】\[\]]/g, ' ');
  s = s.replace(/[\s\-_.,·・'"&/:!?]+/g, ' ');
  for (const w of STRIP) s = s.split(w).join(' ');
  return s.replace(/\s+/g, '');
}
function bigrams(s) {
  const a = [...s];
  if (a.length < 2) return new Set(a.length ? [s] : []);
  const out = new Set();
  for (let i = 0; i + 1 < a.length; i++) out.add(a[i] + a[i + 1]);
  return out;
}
// Bigram Jaccard, with containment counted as 0.8 (丰居 vs 丰居雙連 is the same brand's branch).
export function nameSim(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const j = inter / (A.size + B.size - inter || 1);
  const short = x.length <= y.length ? x : y, long = short === x ? y : x;
  return Math.max(j, [...short].length >= 2 && long.includes(short) ? 0.8 : 0);
}
// Best similarity over several names on each side.
export function bestNameSim(as, bs) {
  let best = 0;
  for (const a of as.filter(Boolean)) for (const b of bs.filter(Boolean)) best = Math.max(best, nameSim(a, b));
  return Math.round(best * 100) / 100;
}

export const hasLatin = (s) => /[A-Za-z]/.test(String(s || ''));
export const hasCJK = (s) => /[㐀-鿿]/.test(String(s || ''));
