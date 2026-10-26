// Swedish for what `uw question` writes into map.config.json (labels, verdict phrases, lens names and personas) when
// the site's "locale" is "sv" (`uw new --lang sv` / `uw question --lang sv`). Same keys and templates as the English
// tables in cmd-question.mjs: {value} is the formatted number with its unit, {n} the bare count.

export const PHRASES_SV = {
  quiet_night_blocks: { lead: 'lugnast gator i närheten', value: '{value} lugna kvarter i närheten', worst: 'minst lugna gator i närheten ({value})', zero: 'inga lugna gator i närheten' },
  lively_night_blocks: { lead: 'livligast gator i närheten', value: '{value} livliga kvarter i närheten', worst: 'minst livliga gator i närheten ({value})', zero: 'inga livliga gator i närheten' },
  quiet_day_blocks: { lead: 'lugnast gator på dagen', value: '{value} lugna kvarter i närheten', zero: 'inga lugna gator i närheten' },
  lively_day_blocks: { lead: 'livligast gator på dagen', value: '{value} livliga kvarter i närheten', zero: 'inga livliga gator i närheten' },
  green_blocks: { lead: 'grönast promenader', value: '{value} gröna kvarter i närheten', zero: 'inga gröna gator i närheten' },
  green: { lead: 'grönast utanför dörren' },
  green_area: { lead: 'grönast promenader' },
  calm_night: { lead: 'tystast vid dörren på natten', worst: 'stökigast vid dörren på natten' },
  calm_night_area: { lead: 'lugnast promenadområde på natten' },
  lively_night: { lead: 'livligast vid dörren på kvällen' },
  lively_night_area: { lead: 'livligast promenadområde på kvällen' },
  noise_night_db: { lead: 'tystast vid dörren på natten', value: '{value} vid dörren på natten', worst: 'mest buller vid dörren på natten' },
  noise_day_db: { lead: 'tystast vid dörren på dagen', value: '{value} vid dörren på dagen', worst: 'mest buller vid dörren på dagen' },
  amenities: { lead: 'mest vardagsservice' },
  main_road_m: { lead: 'längst från stora vägar', value: 'stor väg {value}', worst: 'närmast en stor väg ({value})' },
  tw_price_max: { lead: 'lägst anmält maxpris', value: 'anmält maxpris {value}' },
  nearest_night_market_m: { lead: 'närmast en nattmarknad', value: 'nattmarknad {value} bort' },
};

export const LABELS_SV = {
  green: 'Grönt utanför dörren', calm_night: 'Tyst dörr på natten', lively_night: 'Livlig dörr på kvällen', amenities: 'Vardagsservice', green_area: 'Gröna promenader',
  noise_night_db: 'Trafikbuller vid dörren, natt', noise_day_db: 'Trafikbuller vid dörren, dag', quiet_night_blocks: 'Lugna gator inom 10 min promenad',
  lively_night_blocks: 'Livliga gator inom 10 min promenad', calm_night_area: 'Lugnt på natten, 10 min promenad', green_blocks: 'Gröna gator inom 10 min promenad',
};

/** lens presets: the label on the chip and the persona in the verdict line */
export const LENS_SV = {
  sleep: { label: 'Sömn', persona: 'Lättväckta' },
  night: { label: 'Kväll', persona: 'Nattugglor' },
  move: { label: 'Kollektivt', persona: 'Pendlare' },
  morning: { label: 'Morgon', persona: 'Morgonpigga' },
};

export const NOUNS_SV = {
  cafes: ['kafé', 'kaféer'], cafe: ['kafé', 'kaféer'], coffee: ['kafé', 'kaféer'], mrt: ['MRT', 'MRT-stationer'], metro: ['tunnelbana', 'tunnelbanestationer'],
  nightmarkets: ['nattmarknad', 'nattmarknader'], night_markets: ['nattmarknad', 'nattmarknader'], markets: ['marknad', 'marknader'], parks: ['park', 'parker'],
  gyms: ['gym', 'gym'], restaurants: ['restaurang', 'restauranger'], food: ['matställe', 'matställen'], bars: ['bar', 'barer'], bakeries: ['bageri', 'bagerier'],
  supermarkets: ['mataffär', 'mataffärer'], convenience: ['närbutik', 'närbutiker'], stations: ['station', 'stationer'], stops: ['hållplats', 'hållplatser'],
};

export const WATCH_SV = { 'Night market': 'Nattmarknad' };

/** generated phrases for walk/ride minutes, nearest distance and counts (the English ones are in cmd-question.mjs) */
export const GEN_SV = {
  minutes: (v, n) => ({ lead: `kortast ${v === 'walk' ? 'promenad' : 'resa'} till närmaste ${n}`, value: `{value} ${v === 'walk' ? 'promenad' : 'resa'} till närmaste ${n}`,
    worst: `längst ${v === 'walk' ? 'promenad' : 'resa'} till närmaste ${n} ({value})` }),
  minutesLabel: (v, n) => `${v === 'walk' ? 'Promenad' : 'Resa'} till närmaste ${n}`,
  nearest: (n) => ({ lead: `närmast ${n}`, value: `närmaste ${n} {value} bort`, worst: `längst till närmaste ${n} ({value})` }),
  nearestLabel: (n) => `Avstånd till närmaste ${n}`,
  count: (many) => ({ lead: `flest ${many} i närheten`, value: `{n} ${many} i närheten`, worst: `färst ${many} i närheten ({n})`, zero: `inga ${many} i närheten` }),
  countScope: (num, unit) => (unit === 'min' ? `inom ${num} min promenad` : `inom ${num} m`),
};
