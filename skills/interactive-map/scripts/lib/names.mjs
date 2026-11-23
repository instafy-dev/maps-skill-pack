// What a place's name says, and when another name is that place's: the words that tell one place from another of
// its kind ("Editory" and "Ribeira" in "The Editory House Ribeira"; "hotel" tells nothing), and whether a candidate's
// own names, in any language it carries, hold every one of them. A hotel looked up by its name was pinned as another
// hotel of its chain that shared one word of it ("The Editory Boulevard Hotel" for "The Editory House Ribeira"), and a
// square known by its English name was refused because none of its words names a place on its own ("Main Square" for
// "Main Market Square"). Pure: no network, no files.

// Words that say what kind of place a name is, or where, never which one: a name's word that is one of these does not
// tell two places apart (hotel, taipei, 飯店 …). City and country words are not listed here: they are taken from where
// the candidates are (cmd-geocode.mjs areaWordsOf), any country.
export const GENERIC = new Set(('the a an of de la le el du des and at in by on hotel hotels inn hostel hostal motel resort suites suite residence ' +
  'apartments apartment house guesthouse guest lodge station metro mrt subway railway train restaurant cafe coffee bar pub night market street ' +
  'road rd st ave avenue lane alley park temple shrine museum gallery city center centre plaza tower building mall shop store international ' +
  'grand main central terminal new old north south east west branch').split(' '));
export const CJK_GENERIC = /飯店|酒店|旅館|旅店|商旅|旅社|民宿|車站|夜市|公園|大樓|中心|餐廳|咖啡|分店|門市/g;
// a title a name carries in full or short, or in one language and not another ("Saint Paul's", "St Paul's"; "Mount",
// "Mt"; "Royal Alcázar of Seville" is the "Alcázar of Seville", "Real Alcázar de Sevilla"): never what tells two
// places apart. Each with its kind of title, as each language says it ("Royal" is "Real")
const FAMILY = new Map([
  ...['st', 'ste', 'saint', 'sainte', 'san', 'sant', 'santa', 'santo', 'sao', 'sankt', 'sint'].map((t) => [t, 'saint']),
  ...['mt', 'mount'].map((t) => [t, 'mount']),
  ...['royal', 'real', 'reial', 'reale', 'regio'].map((t) => [t, 'royal']),
  ['imperial', 'imperial'],
  ...['national', 'nacional', 'nazionale', 'nationale'].map((t) => [t, 'national']),
]);
const TITLE = new Set(FAMILY.keys());
// the small words between a name's own ("Palace of Westminster", "Praça do Comércio", "Museo di Capodimonte")
const FILLER = new Set(['the', 'a', 'an', 'of', 'de', 'del', 'della', 'dei', 'di', 'da', 'do', 'dos', 'das', 'la', 'le', 'les', 'el', 'los', 'las', 'lo', 'il',
  'du', 'des', 'and', 'at', 'in', 'on', 'by', 'y', 'e', 'et', 'und', 'der', 'die', 'den', 'van', 'von', 'het']);
// words that say which of two places of a kind a name is only beside another word ("Central" in "Mercado Central",
// "Great" in "Great Market Hall"): generic on their own, never a word of a name's own
const MODIFIER = new Set(['grand', 'main', 'central', 'new', 'old', 'north', 'south', 'east', 'west', 'international', 'great',
  'little', 'upper', 'lower']);
// the one that says the other place of the kind ("New Town Hall" is not the "Old Town Hall")
const OPPOSITE = { old: 'new', new: 'old', north: 'south', south: 'north', east: 'west', west: 'east', upper: 'lower', lower: 'upper', great: 'little', little: 'great' };
// a word of an alphabet (Latin, Greek, Cyrillic …) or a number; scripts written without spaces are compared by pairs
const WORD = /(?:(?![\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])[\p{L}\p{N}])+/gu;
const fold = (x) => String(x ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** A generic word, or its plural ("Vatican Museums", "Galleries"): a word of what kind of place a name is. */
export const isGeneric = (t) => GENERIC.has(t) || (t.length > 3 && t.endsWith('s') && (GENERIC.has(t.slice(0, -1))
  || (t.endsWith('es') && GENERIC.has(t.slice(0, -2))) || (t.endsWith('ies') && GENERIC.has(`${t.slice(0, -3)}y`))));
/** A word long enough to tell by: three letters or more, or a code with a digit ("O2", "A1"). */
const telling = (t) => t.length >= 3 || /\d/.test(t);
/** Is `t` the word `w`, or another ending of it (four letters or more in common at its start, at most three more:
 *  "Gardens", "Garden"; never "Parkview" for "Park")? */
const sameWord = (w, t) => w === t || (w.length >= 4 && t.length >= 4 && Math.abs(w.length - t.length) <= 3 && (w.startsWith(t) || t.startsWith(w)));

/** A name without the names of where the candidates are (`area`: their city, district, country, in any language),
 *  each as a whole phrase: "Porto" goes from "Pestana Vintage Porto", and "United Kingdom" only as itself ("Manchester
 *  United" keeps its "united"). Folded (accents and case aside). */
function withoutArea(name, area) {
  let s = ` ${fold(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const places = [...new Set(area.filter(Boolean).map((a) => fold(a).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const a of places) while (s.includes(` ${a} `)) s = s.replace(` ${a} `, ' ');
  return s.trim();
}

/** The words of the kind a place is, as OpenStreetMap tags it ("historic=castle": historic, castle; "information=board"):
 *  a query word that says the place's kind is judged by its kind, never as a word of its name ("Wawel Castle" is the
 *  castle "Zamek Królewski na Wawelu"; "Roman Gate information board" the board "Roman Gate"). */
const kindWords = (type) => new Set(fold(String(type || '').replace(/[=_:]+/g, ' ')).match(WORD) || []);

/** The words of a query's name (the part before a comma) that tell the place from another of its kind: not a generic
 *  word (hotel, museum, main …), not a title (saint, st, royal), not a word of two letters or fewer unless a code with
 *  a digit,
 *  not a name of where the candidates are (`area`: withoutArea), not the kind word `strip` (a RegExp: "Square" in
 *  "Trafalgar Square", judged by the place's kind instead), and not a word of the kind a candidate is (`type`, its
 *  OpenStreetMap tag); and the pairs of characters of a name in a script written without spaces (飯店 and the like
 *  aside). A plural of a generic word is generic ("Museums"); a code with a digit tells ("O2"). → { words, pairs,
 *  marks: its titles, words such as "Central" and codes in capitals, which a name with a word of its own must carry
 *  (holdsName), all: every word of its name } */
export function distinctiveWords(query, area = [], { strip = null, type = null } = {}) {
  const raw = String(query ?? '').split(/[,，]/)[0];
  area = [...area, ...placesAfterComma(query)];
  const label = withoutArea(strip ? raw.replace(new RegExp(strip.source, 'giu'), ' ') : raw, area);
  const areaText = area.filter(Boolean).map(fold).join(' | ');
  const kind = kindWords(type);
  const all = [...new Set(label.match(WORD) || [])];
  const words = all.filter((t) => telling(t) && !isGeneric(t) && !TITLE.has(t) && !kind.has(t));
  // a title, a word such as "Central", or a code in capitals ("AO"): what the name says only beside another word
  const codes = new Set((raw.match(/(?<![\p{L}\p{N}])\p{Lu}{2}(?![\p{L}\p{N}])/gu) || []).map(fold));
  const marks = all.filter((t) => (TITLE.has(t) || MODIFIER.has(t) || codes.has(t)) && !FILLER.has(t) && !kind.has(t));
  CJK_GENERIC.lastIndex = 0;
  const runs = label.replace(CJK_GENERIC, ' ').match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]{2,}/g) || [];
  const pairs = [...new Set(runs.flatMap((w) => [...w].slice(0, -1).map((c, i) => c + w[i + 1])))].filter((b) => !areaText.includes(b));
  return { words, pairs, marks, all };
}

/** The places a query names after its first comma ("Pestana Vintage Porto, Porto": Porto): where the place is, so
 *  never a word of its name. */
const placesAfterComma = (query) => String(query ?? '').split(/[,，]/).slice(1).map((x) => x.trim()).filter(Boolean);

/** Does one of a place's own names hold the name a lookup asked for: every distinctive word of the query's name
 *  (distinctiveWords), in that one name, in any language the place carries ("Wawel Royal Castle" holds "Wawel Castle";
 *  "The Editory Boulevard Hotel" does not hold "The Editory House Ribeira", nor "OCA Flores Hotel Boutique"
 *  "Descobertas Boutique Hotel")? A word may stand for its plural or another ending of it (four letters or more in
 *  common at its start, at most three more: "Gardens", "Garden"; never "Parkview" for "Park"). A query with no
 *  distinctive word (each of its words generic: "Main Market Square") is held by a name made only of its words, two or
 *  more, that holds its first word and its last, or says one of them by what the place is (`type`, its OpenStreetMap
 *  kind: a square for "… Square"): "Main Square" for "Main Market Square", never "Old Town Hall" for "Old Town". →
 *  true, false (none of its names holds it), or null (the query has nothing to tell by, or the place no name; with
 *  `business`, a lookup of a place to stay, a venue or a business, a name of generic words only that none of its names
 *  is made of is false). `names`: the place's names; `area`, `strip` and `type` as distinctiveWords'. Pure; exported
 *  for the tests. */
export function holdsName(query, names, area = [], { type = null, strip = null, business = false } = {}) {
  const own = (Array.isArray(names) ? names : [names]).filter((n) => typeof n === 'string' && n.trim()).map(fold);
  if (!own.length) return null;
  const { words, pairs, marks, all } = distinctiveWords(query, area, { strip, type });
  const where = [...area, ...placesAfterComma(query)];
  if (words.length || pairs.length) {
    const kind = kindWords(type);
    return own.some((n) => {
      const hay = n.match(WORD) || [];
      const has = (t) => hay.some((h) => sameWord(h, t));
      if (!words.every(has) || !pairs.every((b) => n.includes(b))) return false;
      // a name with a word of its own beside the query's ("Teatro Español" for "Teatro Real", "Opera Holland Park"
      // for "Royal Opera House", "Mercado de Colón" for "Mercado Central", "Copper Box Arena" for "AO Arena") is
      // another place of the kind, unless it carries the query's title, its word such as "Central", its code too.
      // A name that only leaves them out ("Alcázar of Seville" for "Royal Alcázar of Seville") or says its own title
      // ("Real Alcázar de Sevilla") is the place
      // (a title is held by that title in another language: "Real" for "Royal")
      const held = (m) => has(m) || (FAMILY.has(m) && hay.some((h) => FAMILY.get(h) === FAMILY.get(m)));
      if (!marks.length || marks.every(held)) return true;
      // a word of its own: not the query's, nor a generic or a small word; a title of another kind than the query's
      // ("Teatro Nacional" for "Teatro Real"), and a word such as "New" where the query says "Old"
      const titles = new Set(all.filter((t) => FAMILY.has(t)).map((t) => FAMILY.get(t)));
      const own = (t) => {
        if (!telling(t) || FILLER.has(t) || kind.has(t) || all.some((q) => sameWord(q, t))) return false;
        if (FAMILY.has(t)) return !titles.has(FAMILY.get(t));
        if (MODIFIER.has(t)) return all.includes(OPPOSITE[t]);
        return !isGeneric(t);
      };
      return !(withoutArea(n, where).match(WORD) || []).some(own);
    });
  }
  const plain = (s) => (withoutArea(s, where).match(WORD) || []).filter((w) => !FILLER.has(w));
  const asked = plain(String(query ?? '').split(/[,，]/)[0]);
  if (asked.length < 2) return null;
  const set = new Set(asked);
  const kind = new Set(plain(String(type || '').split('=').pop().replace(/_/g, ' ')));
  const its = (w, x) => w.includes(x) || kind.has(x);
  // a business or a venue named with generic words only ("Hotel Plaza") is the one of that name, never one named with
  // more ("Hotel Plaza de Armas"): another of its kind
  return own.some((n) => { const w = plain(n); return w.length >= 2 && w.every((x) => set.has(x)) && its(w, asked[0]) && its(w, asked[asked.length - 1]); }) || (business ? false : null);
}

/** Do two names name one place: either holds the other (holdsName, both ways: "Wawel Castle" and "Wawel Royal Castle").
 *  `area` as distinctiveWords'. Pure. */
export const sameNamed = (a, b, area = []) => holdsName(a, [b], area) === true || holdsName(b, [a], area) === true;

// the words a street's name says it is a street with ("Avenue des Champs-Élysées": avenue), in the languages the map's
// cities use most
const STREET_WORD = /^(streets?|st|str|roads?|rd|avenues?|ave|av|avenida|lanes?|boulevards?|blvd|bd|alleys?|drives?|calle|carrer|rua|rue|via|viale|corso|strasse|straße|gasse|weg|ulica|utca|katu|gatan|gata|vej|straat|laan|promenade|prospekt|paseo|passeig|quai)$/;
/** Is a street's name the name a lookup asked for, its street words aside ("Avenue des Champs-Élysées" for
 *  "Champs-Élysées", "Boulevard de la Croisette" for "La Croisette"): each word of one is a word of the other, the
 *  area's names, the small words between and the street's own street words aside; never "Brentford Street" for
 *  "Manchester United v Brentford". `area` as distinctiveWords'. Pure; exported for the tests. */
export function streetNamed(query, names, area = []) {
  const where = [...area, ...placesAfterComma(query)];
  const words = (s) => (withoutArea(s, where).match(WORD) || []).filter((t) => !FILLER.has(t) && !STREET_WORD.test(t));
  const asked = words(String(query ?? '').split(/[,，]/)[0]);
  if (!asked.length) return false;
  return (Array.isArray(names) ? names : [names]).filter((n) => typeof n === 'string' && n.trim()).some((n) => {
    const own = words(n);
    return own.length > 0 && asked.every((q) => own.some((t) => sameWord(t, q))) && own.every((t) => asked.some((q) => sameWord(q, t)));
  });
}
