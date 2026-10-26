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
// Photon answers by query text (osm_tag type searches get nothing)
const PHOTON = {
  'Via Hotel Loft, Taipei': [feat('丰居旅店', VIA, { street: '民生東路一段', hn: '42', id: 4983984604, type: 'N', en: 'Via Hotel Loft' })],
  'Everstar Hotel, Taipei': [feat('圓山大飯店', [121.526206, 25.078765], { id: 557039975 }), feat('台北喜來登大飯店', [121.522555, 25.044675], { id: 267163040 })],
  'Lore Hotel, Taipei': [],
  'Qwertyuiop Hotel, Taipei': [feat('圓山大飯店', [121.526206, 25.078765], { id: 557039975 })],
  'Everstar Hotel': [feat('Hotel Wöbken', [8.191012, 53.112688], { id: 266516015, type: 'N', district: 'Eversten', city: 'Oldenburg' })],
  'Blue Door Cafe': [feat('Blue Door Cafe', [121.5250, 25.0580], { key: 'amenity', value: 'cafe', id: 77, type: 'N' })],
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
      const feats = (u.searchParams.getAll('osm_tag').length ? [] : PHOTON[q] || []).map((f) => {
        const { name_en, ...p } = f.properties;
        return { ...f, properties: { ...p, name: en && name_en ? name_en : p.name } };
      });
      res.end(JSON.stringify({ type: 'FeatureCollection', features: feats }));
    } else if (u.pathname.includes('interpreter')) {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const q = decodeURIComponent(body.replace(/^data=/, '').replace(/\+/g, ' '));
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
