// Place kind presets: Overpass selectors + emoji + label. Used by `places`, and for emoji lookup elsewhere.
// Each selector is an Overpass filter string applied to nwr (nodes, ways, relations).
const NM = '夜市|[Nn]ight ?[Mm]arket|ナイトマーケット|야시장';

export const KINDS = {
  // amenity=cafe includes cannabis "coffeeshops" (NL) under cuisine=soft drugs; those are never what a traveller means
  // tags: the OSM key:value tag(s) of the kind, for a reverse place search (the places chain's fallback while Overpass
  // cannot answer: names + positions only, ≤ 50 per point)
  cafe:         { emoji: '☕', label: 'Café', tags: ['amenity:cafe'], sel: ['["amenity"="cafe"]["cuisine"!~"soft[ _]drugs|cannabis",i]'] },
  // coffee = cafés that serve coffee: no bubble tea / tea / juice counters, no cannabis coffeeshops
  coffee:       { emoji: '☕', label: 'Coffee', sel: ['["amenity"="cafe"]["cuisine"!~"bubble_tea|^tea$|;tea|tea;|juice|soft[ _]drugs|cannabis|frozen_yogurt|ice_cream",i]'] },
  restaurant:   { emoji: '🍜', label: 'Restaurant', sel: ['["amenity"~"^(restaurant|food_court)$"]'] },
  fast_food:    { emoji: '🍔', label: 'Fast food', sel: ['["amenity"="fast_food"]'] },
  bar:          { emoji: '🍸', label: 'Bar', sel: ['["amenity"~"^(bar|pub|biergarten)$"]'] },
  nightlife:    { emoji: '🌃', label: 'Nightlife', sel: ['["amenity"~"^(bar|pub|nightclub|karaoke_box)$"]', '["leisure"="dance"]'] },
  gym:          { emoji: '🏋️', label: 'Gym', sel: ['["leisure"="fitness_centre"]', '["leisure"="sports_centre"]["sport"~"fitness|crossfit|weightlifting"]', '["amenity"="gym"]'] },
  // parks: public parks, plus gardens only when they have a name (unnamed gardens are mostly private yards and flowerbeds);
  // unnamed results are dropped (named: true) unless --include-unnamed
  park:         { emoji: '🌳', label: 'Park', named: true, sel: ['["leisure"="park"]["access"!~"^(private|no|customers)$"]',
                  '["leisure"="garden"]["name"]["access"!~"^(private|no|customers)$"]["garden:type"!~"residential|private"]'] },
  hotel:        { emoji: '🏨', label: 'Hotel', sel: ['["tourism"~"^(hotel|motel)$"]'] },
  hostel:       { emoji: '🛏️', label: 'Hostel', sel: ['["tourism"~"^(hostel|guest_house)$"]'] },
  supermarket:  { emoji: '🛒', label: 'Supermarket', tags: ['shop:supermarket'], sel: ['["shop"="supermarket"]'] },
  convenience:  { emoji: '🏪', label: 'Convenience store', tags: ['shop:convenience'], sel: ['["shop"="convenience"]'] },
  museum:       { emoji: '🏛️', label: 'Museum', sel: ['["tourism"~"^(museum|gallery)$"]'] },
  // a temple of any of these faiths: the neutral sign of a place of worship (a shrine, Shinto, has its gate)
  temple:       { emoji: '🛐', label: 'Temple', sel: ['["amenity"="place_of_worship"]["religion"~"^(buddhist|taoist|shinto|hindu|chinese_folk|confucian|jain|tenrikyo)$"]', '["historic"="temple"]'] },
  viewpoint:    { emoji: '🔭', label: 'Viewpoint', sel: ['["tourism"="viewpoint"]'] },
  night_market: { emoji: '🏮', label: 'Night market', dedupe: true, dedupeAnyName: 90,
                  sel: [`["amenity"="marketplace"]["name"~"${NM}"]`, `["place"]["name"~"${NM}"]`,
                        `["landuse"~"^(retail|commercial)$"]["name"~"${NM}"]`, `["highway"="pedestrian"]["name"~"${NM}"]`,
                        `["tourism"="attraction"]["name"~"${NM}"]`] },
  // Photon cannot tell metro from train stations (no station=subway): its fallback is any railway station
  mrt_station:  { emoji: '🚇', label: 'Metro station', dedupe: 700, tags: ['railway:station'],
                  sel: ['["railway"="station"]["station"="subway"]', '["railway"="station"]["subway"="yes"]',
                        '["public_transport"="station"]["subway"="yes"]'] },
  train_station:{ emoji: '🚆', label: 'Train station', dedupe: 700, tags: ['railway:station', 'railway:halt'],
                  sel: ['["railway"~"^(station|halt)$"]["station"!~"^(subway|light_rail|monorail|funicular)$"]["subway"!="yes"]["light_rail"!="yes"]'] },
  bike_share:   { emoji: '🚲', label: 'Bike share', sel: ['["amenity"="bicycle_rental"]'] },
  laundry:      { emoji: '🧺', label: 'Laundry', sel: ['["shop"~"^(laundry|dry_cleaning)$"]', '["amenity"="laundry"]'] },
  coworking:    { emoji: '💻', label: 'Coworking', sel: ['["amenity"="coworking_space"]', '["office"="coworking"]'] },
  bakery:       { emoji: '🥐', label: 'Bakery', sel: ['["shop"~"^(bakery|pastry)$"]'] },
  bookstore:    { emoji: '📚', label: 'Bookstore', sel: ['["shop"="books"]'] },
  hot_spring:   { emoji: '♨️', label: 'Hot spring', sel: ['["natural"="hot_spring"]', '["amenity"="public_bath"]', '["bath:type"="hot_spring"]', '["leisure"="hot_spring"]'] },
  // extras
  tea:          { emoji: '🧋', label: 'Tea / bubble tea', sel: ['["shop"="tea"]', '["cuisine"~"bubble_tea|tea"]["amenity"~"^(cafe|fast_food)$"]'] },
  dessert:      { emoji: '🍧', label: 'Dessert', sel: ['["amenity"="ice_cream"]', '["shop"~"^(confectionery|pastry|ice_cream)$"]'] },
  pharmacy:     { emoji: '💊', label: 'Pharmacy', tags: ['amenity:pharmacy'], sel: ['["amenity"="pharmacy"]', '["shop"="chemist"]'] },
  atm:          { emoji: '🏧', label: 'ATM', sel: ['["amenity"="atm"]', '["amenity"="bank"]["atm"="yes"]'] },
  attraction:   { emoji: '🎡', label: 'Attraction', sel: ['["tourism"~"^(attraction|theme_park|zoo|aquarium)$"]'] },
  playground:   { emoji: '🛝', label: 'Playground', sel: ['["leisure"="playground"]'] },
  pool:         { emoji: '🏊', label: 'Swimming pool', sel: ['["leisure"~"^(swimming_pool|sports_centre)$"]["sport"="swimming"]["access"!~"^(private|no|customers)$"]', '["leisure"="water_park"]'] },
  beach:        { emoji: '🏖️', label: 'Beach', sel: ['["natural"="beach"]'] },
  bus_stop:     { emoji: '🚏', label: 'Bus stop', sel: ['["highway"="bus_stop"]'] },
  karaoke:      { emoji: '🎤', label: 'Karaoke', sel: ['["amenity"="karaoke_box"]'] },
  nightclub:    { emoji: '🪩', label: 'Nightclub', sel: ['["amenity"="nightclub"]'] },
  market:       { emoji: '🧺', label: 'Market', sel: ['["amenity"="marketplace"]'] },
  shrine:       { emoji: '⛩️', label: 'Shrine', sel: ['["amenity"="place_of_worship"]["religion"="shinto"]'] },
  toilets:      { emoji: '🚻', label: 'Toilets', sel: ['["amenity"="toilets"]'] },
  ev_charging:  { emoji: '🔌', label: 'EV charging', sel: ['["amenity"="charging_station"]'] },
};

const ALIASES = {
  cafes: 'cafe', coffee_shop: 'coffee', coffee_shops: 'coffee', specialty_coffee: 'coffee', restaurants: 'restaurant', food: 'restaurant', bars: 'bar', pubs: 'bar', pub: 'bar',
  gyms: 'gym', fitness: 'gym', parks: 'park', hotels: 'hotel', hostels: 'hostel', supermarkets: 'supermarket',
  grocery: 'supermarket', konbini: 'convenience', museums: 'museum', temples: 'temple', viewpoints: 'viewpoint',
  night_markets: 'night_market', nightmarket: 'night_market', mrt: 'mrt_station', metro: 'mrt_station',
  subway: 'mrt_station', subway_station: 'mrt_station', metro_station: 'mrt_station', train: 'train_station',
  station: 'train_station', bikes: 'bike_share', bike: 'bike_share', ubike: 'bike_share', laundromat: 'laundry',
  bakeries: 'bakery', books: 'bookstore', bookstores: 'bookstore', onsen: 'hot_spring', hot_springs: 'hot_spring',
  bubble_tea: 'tea', boba: 'tea', ice_cream: 'dessert', pharmacies: 'pharmacy', attractions: 'attraction', sights: 'attraction',
  clubs: 'nightclub', club: 'nightclub', markets: 'market', shrines: 'shrine',
};

export function resolveKind(k) {
  const key = String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (KINDS[key]) return key;
  if (ALIASES[key]) return ALIASES[key];
  if (key.endsWith('s') && KINDS[key.slice(0, -1)]) return key.slice(0, -1);
  return null;
}

// Emoji for an OSM-ish key/value or free kind. A place of worship is any faith's (the place search names none): the
// neutral sign, never one faith's (a cathedral showed a shrine gate). A castle is any country's: the plain castle, not
// the Japanese one (the Alcázar of Seville showed it).
const VALUE_EMOJI = {
  hotel: '🏨', motel: '🏨', hostel: '🛏️', guest_house: '🛏️', apartment: '🏢', cafe: '☕', restaurant: '🍜', fast_food: '🍔',
  bar: '🍸', pub: '🍺', nightclub: '🪩', museum: '🏛️', gallery: '🖼️', attraction: '🎡', viewpoint: '🔭', park: '🌳',
  garden: '🌷', station: '🚉', subway: '🚇', halt: '🚉', aerodrome: '✈️', airport: '✈️', place_of_worship: '🛐',
  marketplace: '🏮', supermarket: '🛒', convenience: '🏪', mall: '🛍️', department_store: '🛍️', bakery: '🥐', books: '📚',
  zoo: '🦁', aquarium: '🐠', theme_park: '🎢', university: '🎓', school: '🏫', hospital: '🏥', beach: '🏖️', peak: '⛰️',
  hot_spring: '♨️', city: '🏙️', town: '🏘️', village: '🏡', suburb: '🏘️', neighbourhood: '🏘️', ferry_terminal: '⛴️',
  bus_station: '🚌', transportation: '🚉', train_station: '🚉', subway_entrance: '🚇', stadium: '🏟️', cinema: '🎬', theatre: '🎭', library: '📖', fitness_centre: '🏋️', castle: '🏰',
  monument: '🗿', memorial: '🗿', island: '🏝️', lake: '🏞️', waterfall: '💧', information: 'ℹ️',
};
export function emojiFor(kindOrValue, fallback = '📍') {
  if (!kindOrValue) return fallback;
  const k = String(kindOrValue);
  if (KINDS[k]) return KINDS[k].emoji;
  return VALUE_EMOJI[k] || fallback;
}

// Classify an OSM element (tags) into one of the requested kinds (first match wins).
export function classify(tags, kinds) {
  for (const k of kinds) {
    for (const sel of KINDS[k].sel) if (matchSel(tags, sel)) return k;
  }
  return kinds[0];
}
// Minimal evaluator for the selector subset used above: ["k"="v"], ["k"~"re"], ["k"!="v"], ["k"!~"re"], ["k"], [!"k"].
export function matchSel(tags, sel) {
  const re = /\[(!?)"([^"]+)"(?:\s*(!?[=~])\s*"([^"]*)"(,i)?)?\]/g;
  let m;
  while ((m = re.exec(sel))) {
    const [, not, k, op, v, ci] = m;
    const has = Object.prototype.hasOwnProperty.call(tags, k);
    const val = tags[k];
    if (not) { if (has) return false; continue; }
    if (!op) { if (!has) return false; continue; }
    if (op === '=') { if (val !== v) return false; }
    else if (op === '!=') { if (val === v) return false; }
    else if (op === '~') { if (!has || !new RegExp(v, ci ? 'i' : '').test(val)) return false; }
    else if (op === '!~') { if (has && new RegExp(v, ci ? 'i' : '').test(val)) return false; }
  }
  return true;
}

// Parse a --tag value: "k=v", "k~regex", "k!=v", "k!~regex", "!k" (key absent), "k" / "k=*" (key present) → Overpass filter.
export function tagFilter(s) {
  const t = String(s).trim();
  let m;
  if ((m = t.match(/^!([\w:.-]+)$/))) return `[!"${esc(m[1])}"]`;
  if ((m = t.match(/^([^=~!]+)!~(.*)$/))) return `["${esc(m[1])}"!~"${esc(m[2])}",i]`;
  if ((m = t.match(/^([^=~!]+)!=(.*)$/))) return `["${esc(m[1])}"!="${esc(m[2])}"]`;
  if ((m = t.match(/^([^=~!]+)=(.*)$/))) return m[2] === '*' ? `["${esc(m[1])}"]` : `["${esc(m[1])}"="${esc(m[2])}"]`;
  if ((m = t.match(/^([^=~!]+)~(.*)$/))) return `["${esc(m[1])}"~"${esc(m[2])}",i]`;
  if (/^[\w:.-]+$/.test(t)) return `["${esc(t)}"]`;
  return null;
}
export const esc = (s) => String(s).trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function osmId(el) { return `osm-${el.type[0]}${el.id}`; }
