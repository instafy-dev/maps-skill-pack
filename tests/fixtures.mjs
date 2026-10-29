// Offline fixtures for the uw tests: a tiny Taiwan lodging register (same shape as ~/.cache/uw/tw-hotels/*.json,
// rows copied from data.gov.tw 7780 / data.taipei 135464 for the hotels the tests use) and a mock Photon/Overpass.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const VIA = [121.52455, 25.057824];

/** The tests' place search is a local mock; Wikipedia's article coordinates (a fallback of the geocode chain, asked
 *  when the search finds nothing) are not part of these fixtures, so the tests never reach the live service. */
export const NO_WIKIPEDIA = { INSTAFY_LOOKUP_PROVIDERS: JSON.stringify({ providers: { 'wikipedia-coords': { enabled: false } } }) };

const row = (o) => ({ alt: [], licField: 'HotelLicenseNumber', cls: 3, city: '臺北市', phones: [], rooms: null, pmin: null, pmax: null, status: 1, web: null, upd: null, ...o });
export const NATIONAL = {
  v: 2, as_of: '2026-10-12', fetched_at: new Date().toISOString(), source_url: 'fixture',
  rows: [
    row({ id: 'Hotel_A15010000H_038630', lic: '臺北市旅館816號', name: '亞士都酒店', lat: 25.05052406859457, lng: 121.52471121239999, town: '中山區',
      address: '臺北市中山區林森北路98號2樓、中山北路1段105巷26號3樓', phones: ['0266099999'], rooms: 6, web: 'https://TaipeiEverStar.com' }),
    row({ id: 'Hotel_A15010000H_019310', lic: '臺北市旅館166號', name: '院院樂居', lat: 25.0634499, lng: 121.5108546, town: '大同區',
      address: '臺北市大同區延平北路三段4號6樓、6樓之1', phones: ['0225850006'], rooms: 20, web: 'https://www.lorehotel.tw', dq: ['樂爾公寓 LORE HOTEL'] }),
    row({ id: 'Hotel_X_1', lic: '臺北市旅館447號', name: '丰居旅店雙連館', lat: 25.0579, lng: 121.5246, town: '中山區', address: '臺北市中山區民生東路一段42號' }),
    // a chain: two branches share a website (ambiguous by website alone)
    row({ id: 'Hotel_X_2', lic: '臺北市旅館900號', name: '康橋商旅南西館', lat: 25.0525, lng: 121.5215, town: '中山區', address: '臺北市中山區南京西路1號', web: 'https://www.kindnesshotel.com.tw' }),
    row({ id: 'Hotel_X_3', lic: '臺北市旅館901號', name: '康橋商旅北門館', lat: 25.0480, lng: 121.5110, town: '大同區', address: '臺北市大同區華陰街1號', web: 'https://www.kindnesshotel.com.tw' }),
    // far away (Kaohsiung): never a Taipei match
    row({ id: 'Hotel_X_4', lic: '高雄市旅館1號', name: '永星酒店', lat: 22.62, lng: 120.30, city: '高雄市', town: '前金區', address: '高雄市前金區1號', web: 'https://everstar-ks.com.tw' }),
    // closed listing with an exact name
    row({ id: 'Hotel_X_5', lic: '臺北市旅館902號', name: '舊時光旅店', lat: 25.0550, lng: 121.5200, town: '中山區', address: '臺北市中山區1號', status: 2 }),
  ],
};
export const REGISTER = {
  as_of: '2026-09-09', fetched_at: new Date().toISOString(), source_url: 'fixture', encoding: 'utf-8',
  rows: [
    { lic: '臺北市旅館166號', name: '樂爾公寓', phones: ['0225850006'], address: '103臺北市大同區延平北路三段4號6樓、6樓之1', pmin: 8000, pmax: 15000, rooms: 20 },
    { lic: '臺北市旅館999號', name: '星空膠囊旅館', phones: [], address: '103臺北市大同區太原路2號', pmin: null, pmax: null, rooms: 10 },
  ],
};

// Taipei Metro open data (rows copied verbatim from data.gov.tw 131734 stations, 128428 entrances, 131733 lines), for
// the stations around the three test hotels; 幸福 is a Circular-line station that only the entrance list has.
export const TW_METRO = {
  stationsText: `\ufeffSEQNO,StationID,StationName,StationPosition,StationAddress,BikeAllowOnHoliday,UpdateTime
34,"'R11,G14'","'{中山,Zhongshan}'","'{121.520364,25.052621}'","'淡水信義線：10444臺北市中山區南京西路16號
松山新店線：10352臺北市大同區南京西路55號'",1,20260902
35,'R12',"'{雙連,Shuanglian}'","'{121.520685,25.057575}'",'10354臺北市大同區民生西路47號',1,20260902
36,"'R13,O11'","'{民權西路,Minzuan W. Rd.}'","'{121.519585,25.06235}'",'10365臺北市大同區民權西路72號',1,20260902
75,'O10',"'{中山國小,Zhongshan Elementary School}'","'{121.526609,25.062665}'",'10452臺北市中山區民權東路1段71號B1',1,20260902
76,'O12',"'{大橋頭,Daqiaotou}'","'{121.5130035,25.06322}'",'10357臺北市大同區民權西路223號B1',1,20260902
`,
  exitsText: `項次,出入口名稱,出入口編號,經度,緯度,是否為無障礙用
129,雙連站出口1,1,121.520588,25.057499,否
130,雙連站出口2,2,121.520615,25.057825,是
131,民權西路站出口1,1,121.519454,25.062641,是
135,民權西路站出口5,5,121.5187721,25.06324045,否
140,民權西路站出口10,10,121.520129,25.062967,是
297,大橋頭站出口1,1,121.512319,25.06318,是
298,大橋頭站出口1A,1A,121.5117348,25.06333204,否
299,大橋頭站出口2,2,121.513258,25.063195,否
300,大橋頭站出口3,3,121.51344,25.063739,否
301,中山國小站出口1,1,121.526095,25.06284,否
340,中山站出口1,1,121.520303,25.052414,否
344,中山站出口5,5,121.519329,25.053037,是
388,幸福站出口1,1,121.460146,25.050126,是
389,幸福站出口2,2,121.4602357,25.04975928,否
`,
  linesText: `\ufeffSEQNO,LineID,LineName,LineColor,IsBranch,LineGroup,UpdateTime
2,'R',"'{'淡水信義線','Tamsui-Xinyi Line'}'",'#d90023',0,'R',20160824
3,'G',"'{'松山新店線','Songshan-Xindian Line'}'",'#107547',0,'G',20160824
4,'O',"'{'中和新蘆線','Zhonghe-Xinlu Line'}'",'#f5a818',0,'O',20160824
`,
};

// Lisbon places for the trip-plan tests (coordinates of the OpenStreetMap objects, rounded): three areas a 3-day stay
// is usually split into (Alfama, Belém, Estrela) and a base hotel in Baixa. Sintra is the usual day trip.
export const LISBON = {
  centre: [-9.1393, 38.7107],
  base: { id: 'baixa-hotel', name: 'Hotel in Baixa', coord: [-9.1390, 38.7110] },
  places: [
    { id: 'castelo', name: 'Castelo de São Jorge', area: 'alfama', coord: [-9.1335, 38.7139] },
    { id: 'se', name: 'Sé de Lisboa', area: 'alfama', coord: [-9.1334, 38.7099] },
    { id: 'santa-luzia', name: 'Miradouro de Santa Luzia', area: 'alfama', coord: [-9.1305, 38.7118] },
    { id: 'jeronimos', name: 'Mosteiro dos Jerónimos', area: 'belem', coord: [-9.2068, 38.6979] },
    { id: 'torre', name: 'Torre de Belém', area: 'belem', coord: [-9.2160, 38.6916] },
    { id: 'padrao', name: 'Padrão dos Descobrimentos', area: 'belem', coord: [-9.2057, 38.6936] },
    { id: 'jardim-estrela', name: 'Jardim da Estrela', area: 'estrela', coord: [-9.1593, 38.7139] },
    { id: 'basilica-estrela', name: 'Basílica da Estrela', area: 'estrela', coord: [-9.1602, 38.7131] },
  ],
  daytrip: { id: 'sintra', name: 'Palácio da Pena', coord: [-9.3906, 38.7876] },
};

export async function writeRegistryCache(cacheRoot) {
  const d = path.join(cacheRoot, 'tw-hotels');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'national.json'), JSON.stringify(NATIONAL));
  fs.writeFileSync(path.join(d, 'taipei-register.json'), JSON.stringify(REGISTER));
  // the tw-metro cache, as the adapter writes it after a download (so places never downloads in the tests)
  const { parseNetwork } = await import('../skills/interactive-map/scripts/adapters/tw-metro.mjs');
  const m = path.join(cacheRoot, 'tw-metro');
  fs.mkdirSync(m, { recursive: true });
  fs.writeFileSync(path.join(m, 'network.json'), JSON.stringify({ v: 1, as_of: '2026-09-03', fetched_at: new Date().toISOString(), ...parseNetwork(TW_METRO) }));
}

const feat = (name, coord, { key = 'tourism', value = 'hotel', street = '', hn = '', district = '中山區', city = '臺北市', id = 1, type = 'W', en = null } = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: coord },
  properties: { osm_type: type, osm_id: id, osm_key: key, osm_value: value, name, ...(en ? { name_en: en } : {}), street, housenumber: hn, district, city, country: '臺灣' },
});
const LX = { district: 'Belém', city: 'Lisboa', country: 'Portugal' };
// Photon answers by query text (osm_tag type searches: PHOTON_TAGGED below)
const PHOTON = {
  'Via Hotel Loft, Taipei': [feat('丰居旅店', VIA, { street: '民生東路一段', hn: '42', id: 4983984604, type: 'N', en: 'Via Hotel Loft' })],
  'Everstar Hotel, Taipei': [feat('圓山大飯店', [121.526206, 25.078765], { id: 557039975 }), feat('台北喜來登大飯店', [121.522555, 25.044675], { id: 267163040 })],
  'Lore Hotel, Taipei': [],
  'Qwertyuiop Hotel, Taipei': [feat('圓山大飯店', [121.526206, 25.078765], { id: 557039975 })],
  'Everstar Hotel': [feat('Hotel Wöbken', [8.191012, 53.112688], { id: 266516015, type: 'N', district: 'Eversten', city: 'Oldenburg' })],
  'Blue Door Cafe': [feat('Blue Door Cafe', [121.5250, 25.0580], { key: 'amenity', value: 'cafe', id: 77, type: 'N' })],
  // Lisbon, the 3-day trip of the 27 Oct 2026 live test: the search lists the viewpoint on top of the monument (named
  // after it) before the monument itself; the zoo and the metro station by it share a name. Names and tags as
  // OpenStreetMap has them, in the search's answer shape.
  'Padrão dos Descobrimentos': [
    feat('Miradouro do Padrão dos Descobrimentos', [-9.205652, 38.693707], { key: 'tourism', value: 'viewpoint', id: 8840011, type: 'N', ...LX }),
    feat('Padrão dos Descobrimentos', [-9.205748, 38.693586], { key: 'historic', value: 'monument', id: 4290022, type: 'W', ...LX }),
  ],
  'Lisbon Airport': [
    feat('Lisbon Airport Shuttle', [-9.133300, 38.770500], { key: 'aeroway', value: 'terminal', id: 8840055, type: 'N', ...LX, district: 'Olivais' }),
    feat('Lisbon Airport', [-9.134110, 38.774170], { key: 'aeroway', value: 'aerodrome', id: 4290066, type: 'W', ...LX, district: 'Olivais' }),
  ],
  'Jardim Zoológico': [
    feat('Jardim Zoológico de Lisboa', [-9.170650, 38.743530], { key: 'tourism', value: 'zoo', id: 4290033, type: 'W', ...LX, district: 'São Domingos de Benfica' }),
    feat('Jardim Zoológico', [-9.168540, 38.742150], { key: 'railway', value: 'station', id: 8840044, type: 'N', ...LX, district: 'São Domingos de Benfica' }),
  ],
  // A landmark whose own name has a word more than the query ("Basilique du …"), listed first, and a hotel and a café
  // named after it nearby, whose names are the query's words plus a generic one. In the search's answer shape.
  'Sacré-Cœur': [
    feat('Basilique du Sacré-Cœur', [2.343076, 48.886719], { key: 'amenity', value: 'place_of_worship', id: 4290077, type: 'W', district: 'Montmartre', city: 'Paris', country: 'France' }),
    feat('Hôtel du Sacré-Cœur', [2.341860, 48.885120], { key: 'tourism', value: 'hotel', id: 8840088, type: 'N', district: 'Montmartre', city: 'Paris', country: 'France' }),
    feat('Café Sacré-Cœur', [2.342500, 48.885800], { key: 'amenity', value: 'cafe', id: 8840099, type: 'N', district: 'Montmartre', city: 'Paris', country: 'France' }),
  ],
  // A square known by another name: OpenStreetMap maps Lisbon's Rossio as "Praça Dom Pedro IV" (place=square, "Rossio"
  // its other name), so a name search lists only the railway station and the stops named after it (the 29 Oct 2026
  // drive put "Rossio" on the map as the station). Names, tags and positions as OpenStreetMap has them.
  'Rossio, Lisbon': [
    feat('Rossio', [-9.137941, 38.714024], { key: 'railway', value: 'station', id: 898569365, type: 'W', ...LX, district: 'Santa Maria Maior' }),
    feat('Lisboa - Rossio', [-9.141525, 38.714118], { key: 'railway', value: 'stop', id: 1932413785, type: 'N', ...LX, district: 'Santa Maria Maior' }),
    feat('Estação Ferroviária de Lisboa - Rossio', [-9.140899, 38.714225], { key: 'building', value: 'train_station', id: 96530649, type: 'W', ...LX, district: 'Santa Maria Maior' }),
  ],
  // Stations that are the place asked for, with a place next to them that the search's filtered answer lists but that
  // is not that place: a lock named after the station (one word in common), and a park Photon matched on "Paris" alone
  // (the live answer for "Gare du Nord, Paris" was parks across Paris; this one is put next to the station).
  'St Pancras International, London': [
    feat('St Pancras International', [-0.127600, 51.532200], { key: 'railway', value: 'station', id: 7020001, type: 'N', district: 'Somers Town', city: 'London', country: 'United Kingdom' }),
  ],
  'Gare du Nord, Paris': [
    feat('Gare du Nord', [2.355000, 48.880400], { key: 'railway', value: 'station', id: 7020011, type: 'N', city: 'Paris', country: 'France' }),
  ],
};
// Photon answers to a search with osm_tag filters (a type search): by query text, only the features whose
// key:value is one of the tags asked for. Every other tagged search gets nothing, as before.
const PHOTON_TAGGED = {
  'Rossio, Lisbon': [
    feat('Praça Dom Pedro IV', [-9.139343, 38.713756], { key: 'place', value: 'square', id: 1317749306, type: 'W', ...LX, district: 'Santa Maria Maior' }),
    feat('Rossio dos Olivais', [-9.095047, 38.767387], { key: 'highway', value: 'pedestrian', id: 581103605, type: 'W', ...LX, district: 'Parque das Nações' }),
  ],
  'St Pancras International, London': [
    feat('St Pancras Lock', [-0.130300, 51.535300], { key: 'tourism', value: 'attraction', id: 7020002, type: 'N', city: 'London', country: 'United Kingdom' }),
  ],
  'Gare du Nord, Paris': [
    feat('Square Alban-Satragne', [2.357800, 48.878600], { key: 'leisure', value: 'park', id: 7020012, type: 'W', city: 'Paris', country: 'France' }),
  ],
};
// Overpass answers to an object lookup (`way(id)`, `node(id)`): the object's tags, its other names among them. The
// square OpenStreetMap maps as "Praça Dom Pedro IV" has "Rossio" as its other name.
const OSM_TAGS = {
  'way/1317749306': { place: 'square', name: 'Praça Dom Pedro IV', alt_name: 'Rossio', highway: 'pedestrian', area: 'yes' },
  'node/7020002': { tourism: 'attraction', name: 'St Pancras Lock', lock: 'yes' },
  'way/7020012': { leisure: 'park', name: 'Square Alban-Satragne' },
};

// cafés around the three Taipei hotels (Via ~ 3, Everstar 1, Lore 0 within 800 m)
const CAFES = [
  [9101, 25.0581, 121.5249, 'Fujin Tree Café'], [9102, 25.0575, 121.5240, 'Rufous Coffee'], [9103, 25.0590, 121.5262, 'Simple Kaffa'],
  [9104, 25.0508, 121.5250, 'Café Astor'],
];
// Mock paths: /api + /reverse (Photon), …/interpreter (Overpass), /routed-foot/table/… (OSRM table).
// Prefixes switch behaviour for the timeout tests: /hang/… never answers, /busy/… answers 504 at once,
// /osrmhang<N>/… answers N OSRM table requests and then hangs.
export function startMock() {
  const hits = [];
  const open = new Set();
  let osrmCalls = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.pathname + u.search);
    res.setHeader('content-type', 'application/json');
    if (u.pathname.startsWith('/hang/')) { open.add(res); req.on('data', () => {}); return; } // never answers
    if (u.pathname.startsWith('/busy/')) { req.on('data', () => {}); req.on('end', () => { res.statusCode = 504; res.end('<html>504 Gateway Timeout</html>'); }); return; }
    const oh = u.pathname.match(/^\/osrmhang(\d+)\//);
    if (oh || u.pathname.includes('/table/v1/')) {
      osrmCalls++;
      if (oh && osrmCalls > Number(oh[1])) { open.add(res); return; }
      const pts = u.pathname.split('/').pop().split(';').map((p) => p.split(',').map(Number));
      // ~80 m per minute on foot, straight line × 1.3
      const d = pts.map((p) => Math.hypot((p[0] - pts[0][0]) * 101000, (p[1] - pts[0][1]) * 111000) * 1.3);
      res.end(JSON.stringify({ code: 'Ok', durations: [d.map((m) => m / 1.3)], distances: [d] }));
      return;
    }
    if (u.pathname.startsWith('/api') && !u.pathname.includes('interpreter')) {
      const q = u.searchParams.get('q');
      const en = u.searchParams.get('lang') === 'en';
      const tags = u.searchParams.getAll('osm_tag');
      const feats = (tags.length ? (PHOTON_TAGGED[q] || []).filter((f) => tags.includes(`${f.properties.osm_key}:${f.properties.osm_value}`)) : PHOTON[q] || []).map((f) => {
        const { name_en, ...p } = f.properties;
        return { ...f, properties: { ...p, name: en && name_en ? name_en : p.name } };
      });
      res.end(JSON.stringify({ type: 'FeatureCollection', features: feats }));
    } else if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
        // an object lookup by id: its tags
        const ids = [...q.matchAll(/\b(node|way|relation)\((\d+)\)/g)];
        if (ids.length) {
          res.end(JSON.stringify({ elements: ids.filter(([, t, id]) => OSM_TAGS[`${t}/${id}`]).map(([, type, id]) => ({ type, id: Number(id), tags: OSM_TAGS[`${type}/${id}`] })) }));
          return;
        }
        // MRT stations near Via (places --kinds mrt_station), cafés (--kinds cafe); everything else: nothing
        const elements = /"station"="subway"/.test(q) ? [
          { type: 'node', id: 9001, lat: 25.0577, lon: 121.5208, tags: { railway: 'station', station: 'subway', name: '雙連', 'name:en': 'Shuanglian' } },
          { type: 'node', id: 9002, lat: 25.0526, lon: 121.5203, tags: { railway: 'station', station: 'subway', name: '中山', 'name:en': 'Zhongshan' } },
        ] : /"amenity"="cafe"/.test(q) && !/nwr\["shop"\]/.test(q) ? CAFES.map(([id, lat, lon, name]) => ({ type: 'node', id, lat, lon, tags: { amenity: 'cafe', name } })) : [];
        res.end(JSON.stringify({ elements }));
      });
    } else if (u.pathname === '/reverse') {
      // Photon reverse (the places fallback when Overpass is busy): stations / cafés within radius (km) of lon,lat
      const lon = Number(u.searchParams.get('lon')), lat = Number(u.searchParams.get('lat')), rKm = Number(u.searchParams.get('radius'));
      const tag = u.searchParams.get('osm_tag');
      const rows = tag === 'railway:station' ? [[9001, 25.0577, 121.5208, '雙連'], [9002, 25.0526, 121.5203, '中山']] : tag === 'amenity:cafe' ? CAFES : [];
      const near = rows.filter(([, la, lo]) => Math.hypot((lo - lon) * 101000, (la - lat) * 111000) <= rKm * 1000);
      res.end(JSON.stringify({ type: 'FeatureCollection', features: near.map(([id, la, lo, name]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lo, la] },
        properties: { osm_type: 'N', osm_id: id, osm_key: tag.split(':')[0], osm_value: tag.split(':')[1], name } })) }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  const close = () => { for (const r of open) { try { r.destroy(); } catch {} } open.clear(); server.closeAllConnections?.(); server.close(); };
  const resetOsrm = () => { osrmCalls = 0; };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, close, resetOsrm, url: `http://127.0.0.1:${server.address().port}` })));
}
