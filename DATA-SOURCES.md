# Map pack: data sources

*Checked 11 Oct 2026 against official terms, policy and pricing pages. "(unverified)" means I could not confirm a point on a primary source. "(prior)" means the point comes from earlier research and was not re-checked here. Prices are list prices on the day.*

## 1. Short version

- **v0 works today with no keys.** Tiles come from OpenFreeMap. Places come from Overpass, search from Photon, routes from FOSSGIS OSRM, walk areas from FOSSGIS Valhalla, air from Open-Meteo and articles from Wikipedia. This is fine for prototypes and personal trip maps.
- **v0 cannot run at Instafy scale.** Each free community service treats all of Instafy as one app. Their policies say heavy or platform use needs your own server. Overpass says apps that serve more than OSM mappers should run their own instance, because "only running your own instance sustainably serves your mission". The FOSSGIS Valhalla maintainers said at launch that their server "won't be usable for any production service for third parties".
- **For production, self-host four things.** These are vector tiles (PMTiles on R2), the geocoder (Photon), routing and isochrones (Valhalla) and a place index (OSM + Overture). Pay for commercial weather and air (Open-Meteo API). In Taiwan, add MOENV air stations and TDX transit. My rough estimate is €250–550 a month plus ops time (§5).
- **The design already keeps load low.** A built site calls only tile servers at runtime. All other data is fetched once by `uw.mjs`, cached, and written to `data/`. Keep it that way. It also makes attribution easy to trace.
- **One build-time read of tiles.** When Overpass cannot give rail track, `lines` reads it from at most 40 OpenFreeMap vector tiles per run (cached 30 days). OpenFreeMap's terms allow automated reads only as a bounded "offline download", and this read stays far inside those bounds. It is fine for v0. For the hosted product, self-host the tiles or get OpenFreeMap's written OK (§3.1a).
- **The licence traps:**
  - Google Maps Platform: link-outs only today. The Places UI Kit card is the one sanctioned in-page route (live, never stored); everything else from Google stays off our pages and out of `data/` (§7).
  - Nominatim bans vibe-coding platforms by name.
  - OSM-derived data files, such as the feel grid, are share-alike under ODbL.
  - Several free tiers are non-commercial only: Open-Meteo, Transitous, MapTiler, Stadia, GraphHopper and the Protomaps API.
  - openrouteservice results and Wikipedia text are CC BY-SA.
  - Taiwan's open-data licence is void without attribution.
  - WAQI forbids caching its data, and the pack caches everything.

## 2. When data is fetched

| When | What | From |
|---|---|---|
| In the viewer's browser, every visit | Vector tiles, fonts, sprites | `tiles.openfreemap.org` |
| In the browser, only when 3D is on | Terrain (terrarium PNG) | `s3.amazonaws.com/elevation-tiles-prod` |
| At build time, by `uw.mjs` (cached in the shared cache; outside an Instafy space also the site's `.uwcache/`) | Places, lines, feel grid, search, routes, isochrones, air, Wikipedia | Overpass, Photon, OSRM, Valhalla, Open-Meteo, Wikipedia |
| At build time, by `uw.mjs lines`, only for rail Overpass could not give (cached 30 days in `~/.cache/uw/basemap-tiles/`) | Rail track from the basemap's vector tiles (`transportation` layer, class `rail`) | `tiles.openfreemap.org` (TileJSON `/planet`, cached 1 day), at most 40 tiles per run (§3.1a) |
| At build time, by `uw.mjs photos` / `uw.mjs adapter` (cached in the shared cache: `UW_CACHE`, else `INSTAFY_CACHE_DIR`, else `~/.cache/uw/`) | Doorstep street photos (metadata; images load from Panoramax in the browser), Taiwan hotel registers, night markets | Panoramax, data.gov.tw, data.taipei, media.taiwan.net.tw |
| On click, by `uw host` handlers | Licence checks, registered hotels nearby | The same cached Taiwan datasets |
| In the browser, on tap | Panoramax thumbnails and 360° images (with credits) | `panoramax.osm.tw` and other instances |
| Never | Google APIs (links are fine), Nominatim, scraped sites | — |

## 3. Sources by dimension

Columns: **Key?** means an account or key is needed. **Proto** means OK for v0 and personal sites. **Prod** means OK as an Instafy-scale backend.

### 3.1 Basemap (vector tiles and style)

| Source | Gives | Coverage | Licence | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|---|
| [OpenFreeMap](https://openfreemap.org/) public | OpenMapTiles-schema vector tiles to z14, styles (Liberty, Bright, Positron, dark), fonts, sprites | Planet (build of 4 Oct 2026 live today) | Data: OSM ODbL. Code: MIT. Commercial use: "Yes" | No | "No limits on the number of map views or requests". No SLA. Donation-funded. The [ToS](https://openfreemap.org/tos/) (updated 14 Oct 2026) bans collecting data "in automated ways, except for offline downloads": at most 3,000 tiles or 50 MB per download, at most 4 parallel requests, a unique User-Agent. Bigger needs: ask info@openfreemap.org | Yes | Yes, but sponsor it and keep a fallback. Better to self-host |
| OpenFreeMap self-hosted | The same stack on your own server | Planet | MIT | No | Your hardware | — | Yes |
| [Protomaps](https://docs.protomaps.com/basemaps/downloads) daily builds (PMTiles) | One planet file, z0–15, ~120 GB. `pmtiles extract` cuts a region | Planet | ODbL Produced Work. OSM attribution required | No | None. You host it | Optional | **Yes** (R2 + Worker) |
| [Protomaps hosted API](https://protomaps.com/api) | Hosted tiles | Planet | "Free for non-commercial use". Commercial use through GitHub Sponsors | Yes | Not stated | Yes | Needs sponsorship |
| [VersaTiles](https://versatiles.org/) public | Vector tiles and styles. Planet download | Planet | OSM ODbL. Asks only for OSM credit | No | No published ToS or limits (unverified). It asks you to cache through your own CDN | Fallback | Self-host only |
| [OSM standard tiles](https://operations.osmfoundation.org/policies/tiles/) | Raster tiles | Planet | ODbL | No | Needs a distinct User-Agent. No prefetching, no offline use, attribution must stay visible | Emergency fallback | No |
| [MapTiler Cloud](https://www.maptiler.com/cloud/pricing/) | Tiles, styles, search, 3D | Planet | Commercial | Yes | Free: 5k sessions and 100k requests a month, for "testing… personal, or non-commercial use". Flex: $30/mo for 25k sessions | Yes | Paid plan |
| [Stadia Maps](https://stadiamaps.com/pricing/) | Tiles, geocoding, routing, isochrones | Planet | Commercial | Yes | Free: 200k credits/mo, "Commercial use not allowed". Starter: $20 for 1M credits. Standard: $80 for 7.5M credits | Yes | Paid plan |

### 3.1a Rail geometry fallback: OpenFreeMap tiles at build time

*Checked 17 Oct 2026 on openfreemap.org, its ToS (updated 14 Oct 2026) and the OpenMapTiles licence.*

**What it does.** `uw lines` draws rail from Overpass. For a long trip or a whole country it fetches the area as 1.5°
tiles. For any tile where Overpass could not give the rail (busy, timed out or empty), it reads the track from the
basemap's own vector tiles instead. Code: `scripts/lib/cmd-lines.mjs` `basemapRail`.
- **Which features:** the OpenMapTiles `transportation` layer, class `rail`, subclass `rail` or `narrow_gauge`, with no `service` tag (yards and sidings dropped).
- **Zoom:** the most detailed zoom from z10 down to z6 that keeps the area at or under **40 tiles** (`MAX_BASEMAP_TILES`). That is about z8 for a country and z10 for a region.
- **Fetching:** one request at a time, with the pack's User-Agent `instafy-map-pack/0.2 (+https://github.com/instafy-dev/maps-skill-pack; contact: https://github.com/instafy-dev/maps-skill-pack/issues)`. Up to 2 retries with backoff on 5xx; a 429 is never retried, and that host is not asked again this turn.
- **Caching:** each tile is kept **30 days** in the shared cache (`UW_CACHE`, default `~/.cache/uw/basemap-tiles/`). A later run reads only tiles that are missing or older than that. The TileJSON is cached for 1 day.
- **Output:** one merged, simplified line feature: `basemap: true`, `hsr_unknown: true`, no line names. The layer is marked PARTIAL.
- **Other servers:** `UW_BASEMAP_TILES` points at any other OpenMapTiles-schema TileJSON.

**Licence.**
- **Data:** OpenStreetMap, ODbL. The rail line written to `data/<layer>.geojson` is an ODbL derivative database, like every other OSM-derived file here (§6, §7).
- **Tile schema:** OpenMapTiles. Code is BSD-3 and the schema/design is CC-BY 4.0. Products built on it must credit "OpenMapTiles" with a link to openmaptiles.org, next to the OSM credit ([LICENSE](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md)).
- **OpenFreeMap:** code is MIT. Commercial use: "Yes". The site says "Attribution is required" and that MapLibre adds it automatically. Clients other than MapLibre must show the OpenFreeMap, OpenMapTiles and OpenStreetMap credits, and the OpenFreeMap part is optional.

**Attribution (done).** The command writes this credit to the layer's `attribution`, and the engine shows it:
`Rail track: OpenFreeMap © OpenMapTiles © OpenStreetMap`, with each name linked. The test `content-gaps.test.mjs`
checks that the credit is there.

**Rate expectations.**
- **What OpenFreeMap says:** "no limits on the number of map views or requests", no registration and no keys. There is no SLA, it is donation-funded and served through Cloudflare.
- **What we send:** at most 41 requests per `lines` run that falls back (1 TileJSON plus 40 tiles), one at a time, with no repeat within 30 days for the same tile.
- **Normal case:** only rail that Overpass missed is read this way, so a typical run reads 0 tiles.

**Do the terms allow it?** Yes, as written today, as long as we stay inside the offline-download limits. It is not
forbidden, but it is not a clear fit either.
- **The rule:** User Conduct bans collecting data "in automated ways, except for offline downloads". An offline download is allowed when it is at most 3,000 tiles or 50 MB, uses at most 4 parallel requests and sends a unique User-Agent identifying the app.
- **Why it fits:** each fallback read is one bounded area read, triggered by one person's map build. It stays far inside every limit: 40 tiles against 3,000, 1 request at a time against 4, and our own User-Agent. 40 tiles at z6-z10 stay under 50 MB even at about 1 MB per tile (unverified for the densest tiles).
- **Why it is not a clear fit:** the exception is written for apps that let people download an area to use offline. We decode the tiles into a rail line stored in the site's data file. The tiles are kept only in our cache, never shown to anyone. That is a looser match than the wording.

**Recommendation.**
- **v0 / prototypes:** keep it as it is. Do not raise `MAX_BASEMAP_TILES` past a few hundred, never fetch tiles in parallel, and never loop `lines` over regions to pull more tiles.
- **Before public launch:** pick one of these.
  1. **Self-host OpenFreeMap (preferred).** It offers weekly full-planet MBTiles/Btrfs downloads, explicitly allowed. Serve them from our own tile server and set `UW_BASEMAP_TILES` to its TileJSON. Same schema, so no code change. It also covers the viewer basemap (§5).
  2. **Get written permission.** Email info@openfreemap.org describing the use: at most 40 tiles per map build, cached 30 days, decoded for rail geometry. Sponsor the project either way.
  3. **Drop the tile fallback.** Read rail from our own OSM extract (Geofabrik `.osm.pbf`, `railway=rail` ways) or our own Overpass. That is the cleanest legally, but it is more to run.
- **Not a drop-in:** Protomaps PMTiles uses a different schema (a `roads` layer with `kind=rail`) and needs range reads, so `basemapRail` would need a second decoder path.

### 3.2 Places and amenities

| Source | Gives | Coverage | Licence | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|---|
| OSM via [Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html) (`overpass-api.de`) | Any OSM tag: cafés, gyms, transit lines, trees, roads | Planet. Taipei has ~14k restaurants, ~2.4k cafés and ~130 gyms, and ~15% of places list opening hours (prior) | ODbL (share-alike) | No | Guideline of ~10,000 requests and 1 GB a day. The [OSM wiki](https://wiki.openstreetmap.org/wiki/Overpass_API) says it is overloaded: no parallel scripts, and pause 30 s after a 429 or 406. Returns 406 to `Accept: application/json` | Yes | **No**. Apps that serve more than OSM mappers should run their own instance |
| Overpass at `overpass.private.coffee` | Same | Planet. Data can lag | ODbL | No | "No rate limit". Asks to be told in advance about large-scale use | Fallback | Ask them first |
| Overpass at `maps.mail.ru` (VK Maps) | Same | Planet | ODbL | No | "No requests limitations" | Fallback only (see §7) | No |
| [Geofabrik extracts](https://download.geofabrik.de/asia/taiwan.html) | Daily `.osm.pbf` per country. Taiwan is 327 MB (9 Oct 2026) | Planet, by region | ODbL | No | None | — | **Yes** (build pipeline) |
| [Overture Maps](https://docs.overturemaps.org/getting-data/) Places | ~74M POIs (prior) with categories, websites and brands. GeoParquet on S3, versioned releases (latest `2026-09-23.1`) | Planet | Mixed per source: CDLA-Permissive 2.0 (Meta, Microsoft…), Apache 2.0 (Foursquare, needs NOTICE), CC0 (AllThePlaces). [Attribution](https://docs.overturemaps.org/attribution/) | No | None (bulk files). Needs DuckDB or the `overturemaps` CLI, not zero-dependency Node | With care | **Yes**. No ODbL share-alike on places |
| [Foursquare OS Places](https://docs.foursquare.com/data-products/docs/access-fsq-os-places) | ~100M POIs (unverified count), categories, closed dates | Planet | Apache 2.0 + NOTICE | Portal token, or a gated Hugging Face dataset where you share contact details | 251 GB release (Hugging Face) | No | Yes (merge into the index) |
| Google Places | Ratings, reviews, hours, photos | Planet | Storage and display bans; the Places UI Kit (live, Google-drawn card) is the only in-page route | Yes | Per load | Link-outs only | UI Kit card via a gateway, never stored (§7) |

### 3.3 Geocoding (search a name, get a point)

| Source | Gives | Licence / terms | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|
| [Photon public](https://photon.komoot.io/) (komoot) | Search-as-you-type, OSM ids, `lat/lon` bias | Software Apache 2.0. Data OSM ODbL | No | "Please be fair – extensive usage will be throttled". The [README](https://github.com/komoot/photon) adds "or completely banned". No availability guarantee | Yes | **No** |
| Photon self-hosted | Same | Apache 2.0 | No | Planet DB ~95 GB disk, 64 GB RAM recommended. Weekly dumps; country dumps exist | — | **Yes** |
| [Nominatim public](https://operations.osmfoundation.org/policies/nominatim/) | Geocoding | ODbL | No | 1 request/s per **application**. No autocomplete. "must not be built into, offered through, suggested by, or automatically generated by no-code, low-code, or vibe-coding platforms" as a generic geocoder | **No** | **No** |
| [openrouteservice](https://account.heigit.org/info/plans) geocode (Pelias) | Geocoding | Results CC BY-SA 4.0 | Yes | 3,000/day, 100/min | Fallback | With care |
| Stadia / MapTiler search | Geocoding | Commercial | Yes | Stadia: 20 credits per request | — | Paid option |

### 3.4 Routing and isochrones (walk, bike, drive)

| Source | Gives | Licence / terms | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|
| [FOSSGIS OSRM](https://routing.openstreetmap.de/about.html) (`routing.openstreetmap.de/routed-{foot,bike,car}`) | Routes with duration and distance | OSM data. You must show attribution **and a "fix the map" link**. Requests are logged | No | "One request per second max". "No scraping, no heavy usage". Valid User-Agent. The full policy is in German on fossgis.de, which blocked my fetch (unverified) | Yes | **No** |
| [FOSSGIS Valhalla](https://github.com/valhalla/valhalla/discussions/3373) (`valhalla1.openstreetmap.de`) | Routes, **isochrones**, matrix | OSM data | No | 1 call/user/s, bursts of 10, 100/s in total. "Service limits are a lot stricter now" (Sep 2026). Not meant for third-party production | Yes | **No** |
| [openrouteservice](https://account.heigit.org/info/plans) (HeiGIT) Standard plan | Directions, isochrones, matrix, POIs, elevation | "Free to use for everyone". **Results are CC BY-SA 4.0**. Credit "© openrouteservice by HeiGIT \| Data from OpenStreetMap" ([ToS](https://account.heigit.org/info/tos)). One account per person | Yes | Directions 2,000/day and 40/min. Isochrones 500/day and 20/min. Matrix 500/day | Fallback | With care (share-alike output) |
| [GraphHopper](https://www.graphhopper.com/pricing/) | Routing, isochrones | Free plan "for non-commercial use only" | Yes | Free: 500 credits/day. Basic: €69/mo for 5k credits/day, isochrones capped at 15 min | No | Weak |
| Self-hosted Valhalla (MIT), OSRM (BSD-2) or GraphHopper (Apache 2.0) | All of the above | Open source | No | Your hardware | — | **Yes** (Valhalla: one engine for routes and isochrones) |

### 3.5 Public transit

| Source | Gives | Coverage | Licence / terms | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|---|
| OSM route relations via Overpass (`lines`) | Line shapes, `colour`, `ref`, stations | Planet. Good in Taipei | ODbL | No | As Overpass | Yes | Via own extracts |
| [Transitous](https://transitous.org/api/) (MOTIS) API | Timetable routing on GTFS | Global. Its [sources](https://transitous.org/sources/) include a **Taiwan TDX feed**: THSR, TRA, Taipei, Taoyuan, Taichung and Kaohsiung metros, buses and ferries, updated 8 Oct 2026 | "Commercial use is not allowed". Only for open-source, non-commercial, light use. Link to transitous.org/sources | No | Contact them before many requests. User-Agent with contact required | Personal only | **No** (self-host MOTIS instead) |
| [TDX](https://tdx.transportdata.tw/) (Taiwan MOTC) | All Taiwan modes: timetables, live arrivals, shapes, stations, YouBike, GTFS | Taiwan | Open Government Data License v1.0 ([example](https://data.gov.tw/en/datasets/161157)) | Yes (OIDC client credentials; token lasts 24 h) | Basic: TWD 0, 3 points a month, **5 calls/min per key**. Bronze: TWD 200+/mo, 5/s. Silver: TWD 1,000, 10/s. Gold: TWD 5,000, 30/s. Platinum: TWD 10,000, 50/s. Apps must cache and relay, not call TDX from the client. Points are charged by calls plus data volume | With key | **Yes** (paid tier + relay) |
| Self-hosted MOTIS + GTFS (TDX, [Mobility Database](https://mobilitydatabase.org/)) | Door-to-door transit routing | Wherever GTFS exists | MOTIS is open source (licence unverified). Feed licences vary | No | Your hardware | — | **Yes** |

### 3.6 Air quality and pollution

| Source | Gives | Coverage / resolution | Licence / terms | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|---|
| [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) (CAMS models) | Hourly PM2.5, PM10, NO₂, O₃, CO, SO₂, `european_aqi`, `us_aqi`, pollen (EU). `past_days` up to 92, forecast up to 7 days | Global grid of 0.4° (**~45 km**). Europe 0.1° (~11 km). This is a model, not a station | CC BY 4.0. Credit Open-Meteo **and CAMS**. [Free API is non-commercial only](https://open-meteo.com/en/terms) | No | Free: under 10k calls/day, 5k/h, 600/min, 300k/month | Yes | Paid plan (API Standard: 1M calls/mo. ~€29/mo per third-party listings, unverified) or self-host |
| [MOENV AQI](https://data.moenv.gov.tw/en/dataset/detail/AQX_P_432) (Taiwan) | Hourly measured AQI and pollutants at ~80 stations (count unverified) | Taiwan, by station | OGDL v1.0 | **Yes**. A keyless call returns "api_key 不存在" (tested) | Not published (unverified) | With free key | **Yes** |
| [OpenAQ v3](https://docs.openaq.org/about/terms) | Station measurements from government and sensor networks | Global, varies | Per-provider licences. Must credit OpenAQ and the original source. No products that "substantially duplicate or directly compete" with OpenAQ | Yes | [60/min, 2,000/h](https://docs.openaq.org/using-the-api/rate-limits) | With key | With care |
| [WAQI / aqicn](https://aqicn.org/api/) | Station AQI | Global | Not for paid apps. **"Can not be redistributed as cached or archived data"** | Yes | 1,000/s | **No** (we cache) | **No** |
| [CAMS](https://apps.ecmwf.int/datasets/licences/cams) direct (Atmosphere Data Store) | Raw model fields | Global / Europe | CAMS licence: royalty-free, with a required notice | Yes (ADS account) | — | No | Self-host route |
| Google Air Quality API | 500 m grid | Global | No caching (Maps terms) | — | — | **No** | **No** |
| Civil IoT / LASS AirBox | Low-cost sensors | Taiwan | Open | — | Every reading was dated 1 Sep 2026, so the feed is stale (prior) | No | No |

### 3.7 Weather and climate

| Source | Gives | Licence / terms | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/en/licence) forecast, historical, climate | Hourly forecast, history, climate normals | CC BY 4.0. Put "Weather data by Open-Meteo.com" next to the data. Free tier is non-commercial. Commercial history and climate need the Professional plan (5M calls/mo) | No | As above | Yes | Paid plan |
| [MET Norway](https://api.met.no/doc/TermsOfService) | Global forecast | CC BY 4.0. Commercial use not stated on the ToS page (unverified) | No | Identifying User-Agent required. Above 20 requests/s per app needs an agreement. Cache and use `If-Modified-Since` | Yes | Likely yes (unverified) |
| Taiwan CWA open data | Forecasts, typhoon warnings, observations | [CWA open-data declaration](https://www.cwa.gov.tw/V8/C/information.html): free reuse with source credit | Yes (free Authorization key) | Not published (unverified) | With key | Yes |
| SunCalc ([BSD-2](https://github.com/mourner/suncalc)) | Sunrise, sunset, golden hour and sun angle, computed locally | BSD-2 | No | None. No network | Yes | Yes |

### 3.8 Noise

There is no global measured noise layer. The pack estimates noise from OSM in `feel`, from road class, above-ground rail, runways and nightlife, and labels it "estimated". The sources below are for checking that estimate where they exist.

| Source | Gives | Coverage | Licence | Key? | Proto | Prod |
|---|---|---|---|---|---|---|
| OSM-based estimate (our `feel`) | Relative calm/lively scores per cell | Planet | ODbL (the grid is a derivative database) | No | Yes | Yes, labelled as an estimate |
| [EU Environmental Noise Directive maps](https://www.eea.europa.eu/data-and-maps/data/data-on-noise-exposure-7) (EEA) | Modelled Lden/Lnight contours. Covers cities over 100k people, roads over 3M vehicles/yr, railways over 30k trains/yr and airports over 50k movements/yr. 2022-round contours published Mar 2026 | EEA32 + UK | EEA re-use policy: free with the source acknowledged | No | Validation | Yes (EU layer) |
| [England strategic noise maps, Round 4](https://www.data.gov.uk/dataset/30b539df-fad0-4652-911e-92af34af0a1d/road-noise-octave-band-data-england-round-4) (Defra) | Modelled road and rail noise for 2021 on a 10 m grid at 4 m height. WMS, WCS and download | England | Open Government Licence | No | Validation | Yes |
| [US BTS National Transportation Noise Map](https://www.bts.gov/geospatial/national-transportation-noise-map) | Road, rail and aviation LAeq 24 h rasters. 2020 data; a 2022/23 release came out in 2026. Values under 45 dBA are dropped | USA | US federal data, likely public domain (unverified). BTS says it is not for judging specific locations | No | Validation | Yes |
| [NoiseCapture](https://noise-planet.org/) (Noise-Planet) | Phone sound measurements | Global, sparse | ODbL ("some of the data") | No | Ground truth | Ground truth |
| NoiseModelling | Computes dB maps from OSM roads and traffic | Anywhere | Open source (GPL, unverified) | No | No | Later |
| Taiwan | Only regulatory zones and monitoring stations. No open street-level map (prior) | — | — | — | — | — |

### 3.9 Greenery, trees and shade

| Source | Gives | Coverage | Licence | Key? | Proto | Prod |
|---|---|---|---|---|---|---|
| OSM (parks, `natural=tree`, tree rows, landuse) | Polygons and points | Planet. Completeness varies | ODbL | No | Yes | Yes |
| [ESA WorldCover](https://esa-worldcover.org/en/data-access) 2020/2021 | 10 m land cover (tree cover, grass, built-up) | Global | CC BY 4.0. S3 bucket, no sign-in needed | No | Build step | Yes |
| [Meta/WRI canopy height](https://registry.opendata.aws/dataforgood-fb-forests/) | ~1 m tree canopy height | Global | CC BY 4.0. Source imagery © Maxar | No | Build step | Yes |
| [Taipei street trees](https://data.gov.tw/en/datasets/128274) | Every street tree with species, trunk diameter and height. Separate files for tree pits and park trees | Taipei City | OGDL v1.0 | No | Yes (23 MB JSON, updated 8 Oct 2026). Coordinates are **TWD97 TM2** (EPSG:3826) and must be reprojected | Yes |
| Taipei green-view study, NUS Urbanity | Street-level greenery index | Taipei, Taichung | CC BY (prior) | No | Later | Yes |
| [ShadeMap](https://shademap.app/about/) | Live shadows from terrain, buildings and trees in MapLibre | Global | Commercial | Yes | "Free on localhost". External domains need a paid tier (price unverified) | Paid |
| Building heights (OSM `height`/`building:levels`, Overture buildings) | Inputs for your own shade estimate | Varies | ODbL | No | Later | Yes |

### 3.10 Terrain

| Source | Gives | Licence | Key? | Proto | Prod |
|---|---|---|---|---|---|
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium, z0–15) | Elevation PNGs for 3D and hillshade | Per-source credits, [listed here](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) (SRTM/USGS, ETOPO1, EU-DEM…) | No | **Yes** (current engine) | Yes |
| [Mapterhorn](https://mapterhorn.com/data-access/) | Terrarium WebP 512 px at `tiles.mapterhorn.com`, plus PMTiles downloads. Sources include **Taiwan's MOI 20 m DTM** (OGDL) and Copernicus GLO-30 ([sources](https://download.mapterhorn.com/attribution.json)) | Code BSD-3. Data per source | No | Try it | Yes (self-host PMTiles). Public endpoint terms not published (unverified) |

### 3.11 Street-level imagery

| Source | Gives | Licence / terms | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|
| [Mapillary](https://www.mapillary.com/developer/api-documentation) | Street photos near a point, detected objects | Images are CC BY-SA 4.0. Show the Mapillary logo and a link ([terms](https://www.mapillary.com/terms) §11). No real-time navigation use. No unapproved data mining | Yes (client token) | 60k entity calls/min, 10k search calls/min, 50k tiles/day | With token | Yes |
| [Panoramax](https://docs.panoramax.fr/) | Open, federated street photos. Meta-catalogue at `api.panoramax.xyz`; OSM Taiwan runs its own instance, `panoramax.osm.tw` | Licence depends on the instance: CC BY-SA 4.0 or Etalab 2.0 ([OSM wiki](https://wiki.openstreetmap.org/wiki/Panoramax)). Check each picture; `panoramax.osm.tw` is CC BY-SA 4.0 | No | No published rate limit (unverified); we keep to 2 requests/s and cache | Yes (`uw photos`) | Yes, with a thumbnail mirror at scale. **Taipei coverage is dense** (checked 11 Oct 2026): 180-420 photos per ~800 m box around each test hotel, half to two thirds 360°, mostly 2024-2026. Doorstep photos (≤ 40 m, facing the door) exist for Via (Jul 2026) and Lore (Jan 2026), none for Everstar (nearest ~110 m). About 1% are taken after 19:00 |
| [Global Streetscapes](https://huggingface.co/datasets/NUS-UAL/global-streetscapes) (NUS) | 10M images across 688 cities with attributes (greenery, view, quality). ~198k in Taipei (prior) | Tables are CC BY-SA 4.0. Images come from Mapillary and KartaView under their terms | No | Bulk | Research | With care |
| Google Street View | Panoramas at a point and heading | Standard terms: a plain "Street View ↗" link only; no embed or tiles next to a non-Google map, no indexes or ML from Street View. EEA billing: an in-card Embed/Maps JS panel looks allowed (to confirm with Google) | Link: no. Embed: yes | — | Link only (`links.streetview`) | Link; panel only under EEA billing after confirmation |

### 3.12 Place enrichment

| Source | Gives | Licence / terms | Key? | Limits | Proto | Prod |
|---|---|---|---|---|---|---|
| Wikipedia geosearch + extracts | Notable places near a point, with a short text and a URL | Text is CC BY-SA 4.0: credit it and keep it share-alike. [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy). [Etiquette](https://www.mediawiki.org/wiki/API:Etiquette): requests one at a time, cache | No | No hard read limit. Radius 10 m–10 km, up to 500 results (tested) | Yes | Yes |
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Licensing) | Ids, official sites, images, heritage status | CC0 | No | Same etiquette | Yes | Yes |
| Wikimedia Commons | Photos | Licence varies per file | No | — | With care | With care |
| OSM `opening_hours` + [opening_hours.js](https://github.com/opening-hours/opening_hours.js) | "Open now", next change | LGPL-3.0. Its public holiday list does not include Taiwan | No | — | Yes | Yes |
| Overture / Foursquare | Categories, websites, brands, closed flags | As in 3.2 | No | — | Later | Yes |

### 3.13 Crowds and liveliness

| Source | Gives | Licence / terms | Key? | Proto | Prod |
|---|---|---|---|---|---|
| OSM POI density, nightlife, opening hours (our `feel`) | A "lively" proxy for day and night | ODbL | No | Yes | Yes (label it estimated) |
| [YouBike 2.0 live feed](https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json) (Taipei) | Bikes and docks per station, refreshed about once a minute (observed) | Taipei open data. OGDL is likely (unverified for this feed) | No | Yes | Yes (cache) |
| Taiwan [SEGIS phone-signal population](https://segis.moi.gov.tw/STATCloud/Signal) | Day and night population | Free by district. NT$2,000–9,500 for finer areas. Latest free release Nov 2023 (prior) | Order | Later | Yes |
| BestTime.app | Hourly busyness per venue (0–100%) | Commercial. Basic is $0.04/credit with a $29/mo minimum, per BestTime's [comparison page](https://besttime.app/alternatives/safegraph) (unverified on a pricing page) | Yes | No | Maybe |
| Google Popular Times | — | No API. Scraping breaks Maps terms §3.2.3(a) | — | **No** | **No** |

### 3.14 Safety and cleanliness (handle with care)

| Source | Gives | Licence | Notes |
|---|---|---|---|
| Taiwan NPA [A1](https://data.gov.tw/en/datasets/12818)/A2 traffic accidents | Crash points with longitude and latitude | OGDL v1.0 | **The most defensible safety layer.** In Taiwan, traffic is a bigger walking risk than crime (prior). Show it as "traffic crashes per km", not as "danger" |
| [Taipei residential burglary points](https://data.gov.tw/dataset/130312) | Case type, date, time band and a **fuzzed address**. No coordinates. Covers Jan 2015 to Aug 2026 | OGDL v1.0 | Don't geocode fuzzed addresses into points. Aggregate by district or leave it out |
| [Project Sidewalk Taipei](https://sidewalk-taipei.cs.washington.edu/api) | Labels for missing sidewalks, obstacles and surface problems, plus AccessScore | CC0 | Taipei is only ~5% audited (prior) |
| Taipei sidewalk widths | Sidewalk geometry and width | OGDL (prior) | Good for a walkability layer |
| Cleanliness, litter, "trashy" | — | — | **No defensible open source.** Image models rate wealth, not cleanliness (prior). Do not map it |

## 4. Recommended stack v0 (now, free, keyless)

| `uw.mjs` command | Source | Notes |
|---|---|---|
| (runtime) basemap | OpenFreeMap Liberty style | Attribution comes from the TileJSON automatically |
| (runtime) terrain | AWS terrarium | Credit is already in `engine/look.js` |
| `geocode`, `add-point` | Photon (komoot) | Prints alternatives. Bias with `--near` |
| `places`, `lines`, `feel` | Overpass: `overpass-api.de`, then `overpass.private.coffee` | At most 1 request/s with a lock. Cached 7 days. Area capped at 60 km² |
| `route` | FOSSGIS OSRM foot/bike/car | 1 request/s. Add the "fix the map" link |
| `isochrone` | FOSSGIS Valhalla | 1 request/s. Cache by source feature id |
| `air` | Open-Meteo Air Quality (CAMS) | One call per location. Label it "regional model" |
| `wiki` | Wikipedia geosearch + extracts | One call at a time |
| `legs`, `enrich`, `validate`, `serve`, `snapshot` | No network (they work on local files) | Durations for `legs` must come from the user or a timetable, never a guess |

Optional upgrades that need a free key, for when the user asks and supplies the key:
- MOENV for measured Taiwan air.
- TDX for Taiwan timetables, at 5 calls a minute.
- openrouteservice as a routing and isochrone fallback. Its results are CC BY-SA.
- A Mapillary token for street photos in the card.
- A CWA key for typhoon and weather warnings.

## 5. Recommended stack v1 (production at platform scale)

**Principle: one shared "map-data gateway" owned by Instafy.** `uw.mjs` keeps its commands but reads endpoints from environment variables. The gateway:
- removes duplicate requests across users;
- caches results;
- applies per-user quotas;
- sends one honest User-Agent with a contact email;
- can switch any upstream off without a pack update. Nominatim-style policies require this switch.

| Component | Do | Why | Rough monthly cost (my estimate) |
|---|---|---|---|
| Basemap tiles | Self-host a Protomaps planet PMTiles file (~120 GB) on Cloudflare R2 with a Worker. Keep OpenFreeMap as a fallback and sponsor it | R2: $0.015/GB-month, $0.36 per million reads, **no egress fees** ([pricing](https://developers.cloudflare.com/r2/pricing/)). The style stays editable | $10–80 (storage ~$2, plus reads and Worker at tens of millions of tiles) |
| Terrain | AWS terrarium (free), or Mapterhorn PMTiles self-hosted for better Taiwan relief | Free public data | $0–20 |
| Geocoding | Self-host Photon (planet: 95 GB disk, 64 GB RAM). Weekly dump refresh | The public Photon throttles or bans heavy users. Nominatim is banned | €60–100 (one 64 GB server) |
| Routing + isochrones | Self-host Valhalla (MIT) for walk, bike and car, planet or the regions you cover | FOSSGIS servers are not for third-party production | €60–100 |
| Places / feel / lines | Monthly build: Geofabrik or planet OSM + Overture Places + Foursquare OS Places → GeoParquet on R2 → a small query API (DuckDB). Optionally a private Overpass for ad-hoc tags | The public Overpass is overloaded. Overture/Foursquare fill OSM gaps (gyms) without share-alike | €40–100 |
| Transit | Self-host MOTIS with GTFS (TDX for Taiwan, Mobility Database elsewhere). TDX Bronze or higher for live data, through the gateway | Transitous is non-commercial. TDX requires a relay | €20–60 + TWD 200–1,000 (~$6–31) |
| Air + weather | Open-Meteo API Standard (1M calls/mo), or Professional for history and climate. MOENV for Taiwan stations. OpenAQ as a cross-check | The free tier is non-commercial | ~€29–99 (unverified prices) |
| Street photos | Mapillary API with an Instafy app token | Free with attribution | $0 |
| Wikipedia/Wikidata | Gateway cache, one request at a time | Etiquette | $0 |
| **Total** | | | **~€250–550 a month**, plus ~1 day a month of ops |

**If you want low ops instead:** buy tiles, search, routing and isochrones from Stadia ($80/mo for 7.5M credits; geocodes and isochrones cost 20 credits each, so ~375k calls) or MapTiler Flex ($30/mo for 25k sessions plus overage). Keep Overture and OSM extracts for places, since neither vendor gives you storable POIs.

## 6. Attribution obligations

The engine always shows "© OpenStreetMap contributors" and OpenFreeMap. MapLibre adds the OpenFreeMap TileJSON credit: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap". Under the [OSMF guideline](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines), the credit sits in a map corner. It may collapse behind an (i) button after interaction or after 5 seconds. "OpenStreetMap" should link to openstreetmap.org/copyright. Add the lines below when the matching data is used. Agent-ready strings are in `skills/interactive-map/reference/data-sources.md`.

| Source | Required credit |
|---|---|
| OSM-derived files (`places`, `lines`, `feel`) | "© OpenStreetMap contributors (ODbL)". Downloadable data files must name and link the ODbL |
| `lines` rail from the basemap tiles (fallback) | "Rail track: OpenFreeMap © OpenMapTiles © OpenStreetMap", each linked. OpenMapTiles (CC-BY 4.0 schema) and OSM are required; the OpenFreeMap part is optional by their terms. Written to the layer's `attribution` by `uw lines` (§3.1a) |
| FOSSGIS OSRM | Attribution plus a link to `https://www.openstreetmap.org/fixthemap` |
| Valhalla FOSSGIS | OSM credit. Courtesy line "Valhalla (FOSSGIS)" |
| Photon | No credit required beyond OSM (not stated). Courtesy line "Search: Photon by komoot" |
| Open-Meteo | A link "Weather data by Open-Meteo.com" next to the data (CC BY 4.0) |
| CAMS (via Open-Meteo or direct) | "Contains modified Copernicus Atmosphere Monitoring Service Information 2026" (we average hours, so "modified"). Also state that "neither the European Commission nor ECMWF is responsible for any use…". Put it on the sources page or in the air card |
| Taiwan OGDL data (MOENV, TDX, Taipei, NPA, MOI DTM) | Use the Exhibit format: "[Agency] [year] [dataset name and version]" + "The Open Data is made available to the public under the Open Government Data License…" + "https://data.gov.tw/license". **Missing attribution voids the licence from the start** ([OGDL §3.2](https://data.gov.tw/en/license)). It is CC BY 4.0-compatible, so a short map credit plus the full text on a sources page is my reading of what suffices |
| Wikipedia text | "Text: Wikipedia contributors, CC BY-SA 4.0" plus a link to each article |
| Mapillary | The Mapillary logo plus a link. Images CC BY-SA 4.0 |
| Panoramax | Per photo: "© <author> · CC BY-SA 4.0 · Panoramax" linking the picture, plus "Street photos: Panoramax contributors (CC BY-SA 4.0)" in the map credits. `uw photos` writes both and `validate --signal` fails a photo without author, licence, date or link |
| Taiwan hotel registers (data.gov.tw 7780, 135464) | "旅館資料：交通部觀光署、臺北市政府 (data.gov.tw，政府資料開放授權條款第1版)", written by `uw adapter tw-hotels` |
| Taipei night markets (data.gov.tw 121594) | "夜市資料：臺北市政府市場處 (data.gov.tw，政府資料開放授權條款第1版)", written by `uw adapter tw-night-markets` |
| Overture | "© Overture Maps Foundation, overturemaps.org" plus per-source credit. Foursquare: "Copyright 2024 Foursquare Labs, Inc." plus ship its NOTICE file |
| openrouteservice | "© openrouteservice by HeiGIT \| Data from OpenStreetMap". Output is CC BY-SA 4.0 |
| ESA WorldCover | "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium" |
| Meta/WRI canopy | "Meta and World Resources Institute (WRI) 2024, High Resolution Canopy Height Maps, CC BY 4.0. Source imagery © 2016 Maxar" |
| AWS terrain | The engine links to the per-source list. Add "Mapterhorn" plus its source list if you switch |
| Transitous | A visible link to `https://transitous.org/sources/` |
| OpenAQ | OpenAQ plus the original provider |

## 7. Red lines

- **Google Maps Platform: links, a live UI Kit card and chat grounding only; never baked, never summarised.** The rules (sources in §11):
  - **Always allowed: link-outs.** Maps URLs ("Google Maps ↗", "Street View ↗" at a point and heading, "Transit directions ↗") use no API and no key. The pack's cards build them (`links`).
  - **The one in-page exception: the Places UI Kit** (GA Essentials elements), a Google-drawn card that SST §15.1 allows next to a non-Google map. Load it on tap, keep Google's attribution, mark it off from our facts, and never store or summarise its content. Needs a key per site behind a gateway. Not in v0.2.
  - **Chat, not page: Maps Grounding Lite** answers in Instafy chat with Google links (SST §10), never written into site files.
  - **Never** (standard terms §3.2.3): Places data (names, ratings, reviews, hours, photos) stored in `data/`, copied into Compare or prompts, or used for our own counts or point-in-polygon analysis; Street View, Static images or Google 3D tiles on the same screen as our MapLibre map; content created from Google content or used to train models. Only `place_id` (and Street View `pano_id`) may be stored.
  - **EEA billing changes the picture**: the non-Google-map ban falls away, so an in-card Street View panel looks allowed, but raw Places content is then barred next to any map. Decide where billing lives, then ask Google in writing.
  - Do not fork the engine onto a Google basemap (pattern B): it breaks restyling and costs about 5x more.
- **Nominatim (public): never.** Its policy names vibe-coding platforms. An LLM may suggest it only with a prominent link to the policy and its restrictions.
- **ODbL share-alike.**
  - A rendered map is a Produced Work and needs attribution only.
  - Our `data/*.geojson` built from OSM, and the feel grid especially, are Derivative Databases. Publishing the site publishes them, so they must be offered under ODbL.
  - Keep OSM-derived layers in their own files, with `source` and licence in `feel.meta.json`. Mixing them in separate files with Overture or OGDL data makes a Collective Database, and only the OSM part is share-alike ([OSMF guidelines](https://osmfoundation.org/wiki/Licence/Community_Guidelines)).
  - Ask the OSMF Licensing Working Group before selling a score API built on OSM (prior).
- **Non-commercial free tiers.** These cannot back a paid Instafy feature without a paid plan: Open-Meteo free, Transitous, MapTiler Free, Stadia Free, GraphHopper Free, the Protomaps hosted API and WAQI.
- **Share-alike outputs.** openrouteservice results, Wikipedia text, Mapillary images and Global Streetscapes tables are CC BY-SA. Fine to show and credit. Don't relicense them.
- **No caching where it is banned.** This covers WAQI and Google. Our pipeline always caches, so never wire these in.
- **No direct client calls to TDX.** TDX's rules require a relay or cache.
- **Mapillary** may not be used for real-time navigation.
- **People and places.** Never label streets or areas "unsafe", "trashy" or "bad".
  - Don't plot crime points from fuzzed addresses.
  - Don't map shelters or migrant centres.
  - Taiwan has criminal defamation (Art. 310) (prior).
  - Show measured, sourced facts ("12 crashes/km, 2025") or clearly labelled estimates.
- **Volunteer services.** Don't loop, don't fan out in parallel, and don't scrape whole cities through the public Overpass, OSRM or Valhalla. Cap areas and cache.

## 8. Taiwan specifics

| Need | Best source | Key | Licence | Notes |
|---|---|---|---|---|
| Transit timetables and live data | TDX | Yes (free: 5/min) | OGDL | Pay TWD 200+/mo for 5/s. Must cache and relay. Its GTFS also feeds Transitous |
| Metro/rail lines on the map | OSM route relations | No | ODbL | Colours come from the `colour` tag |
| Air (measured) | MOENV AQX_P_432, hourly | Yes (free) | OGDL | Better than CAMS at ~45 km. October–March is the bad season, worst from Taichung south (prior) |
| Weather, typhoons | CWA open data | Yes (free) | Open-data declaration with source credit | Add a "typhoon warning" chip later |
| Street trees | Taipei street tree inventory | No | OGDL | TWD97 TM2 → WGS84. 23 MB. Includes species, diameter and height |
| Sidewalks | Taipei sidewalk widths; Project Sidewalk | No | OGDL; CC0 | Narrow lanes without sidewalks are often *pleasant* in Taiwan (prior) |
| Bikes | YouBike 2.0 live JSON | No | Likely OGDL (unverified) | ~1 MB, refreshed every minute |
| Traffic safety | NPA A1/A2 crash points | No | OGDL | Has coordinates |
| Crowds | SEGIS phone-signal population | Order | Paid for fine grids | District level is free (prior) |
| Terrain | MOI 20 m DTM (via Mapterhorn) | No | OGDL | Better than SRTM in the mountains |
| Places | OSM + Overture + Foursquare | No | Mixed | OSM is thin on gyms and opening hours in Taipei (prior) |

Other points:
- **Labels:** the basemap prefers `name:en`, then the local name. Many lanes (巷/弄) have no English name. Show the local name rather than nothing.
- **Holidays:** opening_hours.js has no Taiwan public holidays, so treat "PH" rules as unknown.
- **Addresses:** Photon handles "Chifeng St" style queries in English and Chinese. Always bias with `--near` and show the alternatives (unverified quality, so test it).

## 9. Open questions

- **FOSSGIS full policy.** The German policy text on fossgis.de sits behind a bot wall. I confirmed only the OSRM excerpt and the Valhalla maintainer statements. Ask fossgis-routing-server@openstreetmap.de whether an AI build platform may use OSRM and Valhalla for prototypes.
- **Photon and platforms.** komoot sets no number. Ask komoot whether Instafy-wide use, shared User-Agent and cached, is acceptable during the beta.
- **OpenFreeMap and AI-generated sites.** It is OK for commercial use with no limits. Viewer traffic is fine. Its ToS (14 Oct 2026) bans automated collection except "offline downloads" (≤ 3,000 tiles or 50 MB, ≤ 4 parallel, unique User-Agent). The `lines` rail fallback stays inside those limits (§3.1a), but the wording is written for offline-use downloads. Before launch, self-host or get a written OK from info@openfreemap.org. Also confirm that snapshot rendering in CI is fine.
- **Open-Meteo prices and "commercial".** The commercial plan prices (€29 / €99) come from third-party listings. Is a personal trip site built on Instafy, a commercial platform, "commercial use"? Probably yes for Instafy-hosted previews. Buy API Standard before public launch.
- **VK Maps Overpass.** It is operated in Russia. It has no published terms beyond "no limitations". Decide whether a commercial platform should send queries there (§10).
- **Mapterhorn and VersaTiles public endpoints.** Neither publishes usage terms. Use their downloads, not their endpoints, in production.
- **TDX points.** The conversion of calls and bytes to points is published only as an image. How many calls 3 free points buy is unknown.
- **ODbL scope of the feel grid.** It is mixed with OGDL tree data in Taipei. I believe separate files keep the Collective Database boundary clean. Get a legal read before selling scores.
- **OGDL short-form credit.** Is a short map credit plus the full Exhibit text on a sources page enough? My reading says yes, given the CC BY 4.0 compatibility clause. Not tested.

## 10. Recommended changes to ENGINE-SPEC sources

- **Overpass fallback list:**
  - Drop `overpass.kumi.systems`; it is the old name of `private.coffee`, so it only duplicates load on the same operator.
  - Make `maps.mail.ru` opt-in only, via `UW_OVERPASS`.
- **`air` in Taiwan:**
  - Keep Open-Meteo as the keyless default.
  - Add `--source moenv` (with `MOENV_API_KEY`) for measured station AQI.
  - Always write `resolution_km` and `kind: "model"|"station"` into `air.json`, so the chip can say "regional".
- **Endpoints via environment variables:** `UW_PHOTON`, `UW_OSRM`, `UW_VALHALLA`, `UW_OPENMETEO`, like the existing `UW_OVERPASS`. Instafy can then point everything at its gateway without editing the skill.
- **Attribution defaults:**
  - The `route` command should add the FOSSGIS "fix the map" link to the layer's `attribution`.
  - `air` should add the CAMS notice.
  - `wiki` should add the CC BY-SA line.
- **Terrain:** keep AWS terrarium for v0. Evaluate Mapterhorn for v1, for Taiwan's 20 m DTM and 512 px tiles.
- **Transit durations for `legs`:** these must come from the user or a timetable (TDX or a published THSR/TRA schedule), never a guess. Add a `source` property on each leg.

## 11. Sources

**Basemap and terrain**
- OpenFreeMap: https://openfreemap.org/ · ToS: https://openfreemap.org/tos/ (updated 14 Oct 2026, checked 17 Oct 2026) · TileJSON: https://tiles.openfreemap.org/planet
- OpenMapTiles licence: https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md
- Protomaps builds: https://docs.protomaps.com/basemaps/downloads · API: https://protomaps.com/api
- VersaTiles: https://versatiles.org/
- OSM tile policy: https://operations.osmfoundation.org/policies/tiles/
- MapTiler pricing: https://www.maptiler.com/cloud/pricing/ · Stadia pricing: https://stadiamaps.com/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- AWS Terrain Tiles: https://registry.opendata.aws/terrain-tiles/ · attribution: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- Mapterhorn: https://mapterhorn.com/data-access/ · sources: https://download.mapterhorn.com/attribution.json

**OSM, places, geocoding**
- OSM copyright: https://www.openstreetmap.org/copyright · attribution guideline: https://osmfoundation.org/wiki/Licence/Attribution_Guidelines · community guidelines: https://osmfoundation.org/wiki/Licence/Community_Guidelines
- Overpass commons: https://dev.overpass-api.de/overpass-doc/en/preface/commons.html · instances: https://wiki.openstreetmap.org/wiki/Overpass_API
- Geofabrik Taiwan: https://download.geofabrik.de/asia/taiwan.html
- Overture: https://docs.overturemaps.org/getting-data/ · https://docs.overturemaps.org/attribution/
- Foursquare OS Places: https://docs.foursquare.com/data-products/docs/access-fsq-os-places · https://huggingface.co/datasets/foursquare/fsq-os-places
- Photon: https://photon.komoot.io/ · https://github.com/komoot/photon
- Nominatim policy: https://operations.osmfoundation.org/policies/nominatim/
- Google Maps Platform terms: https://cloud.google.com/maps-platform/terms · Places policies: https://developers.google.com/maps/documentation/places/web-service/policies

**Routing and transit**
- FOSSGIS OSRM: https://routing.openstreetmap.de/about.html · FOSSGIS terms (German, bot-walled): https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/
- Valhalla FOSSGIS server notes: https://github.com/valhalla/valhalla/discussions/3373
- openrouteservice plans: https://account.heigit.org/info/plans · ToS: https://account.heigit.org/info/tos
- GraphHopper pricing: https://www.graphhopper.com/pricing/
- Transitous API: https://transitous.org/api/ · sources: https://transitous.org/sources/
- TDX: https://tdx.transportdata.tw/ · pricing (JSON): https://tdx.transportdata.tw/webapi/pricing/ · sample code and auth: https://github.com/tdxmotc/SampleCode

**Air, weather, sun**
- Open-Meteo terms: https://open-meteo.com/en/terms · licence: https://open-meteo.com/en/licence · pricing: https://open-meteo.com/en/pricing · air quality API: https://open-meteo.com/en/docs/air-quality-api
- CAMS licence: https://apps.ecmwf.int/datasets/licences/cams
- OpenAQ terms: https://docs.openaq.org/about/terms · rate limits: https://docs.openaq.org/using-the-api/rate-limits
- WAQI API: https://aqicn.org/api/
- MET Norway ToS: https://api.met.no/doc/TermsOfService
- MOENV AQI: https://data.moenv.gov.tw/en/dataset/detail/AQX_P_432
- CWA open-data declaration: https://www.cwa.gov.tw/V8/C/information.html
- SunCalc: https://github.com/mourner/suncalc

**Noise, green, imagery, enrichment**
- EEA noise data: https://www.eea.europa.eu/data-and-maps/data/data-on-noise-exposure-7
- England Round 4 road noise: https://www.data.gov.uk/dataset/30b539df-fad0-4652-911e-92af34af0a1d/road-noise-octave-band-data-england-round-4 · Defra 2022 mapping: https://www.gov.uk/government/publications/strategic-noise-mapping-2022
- US BTS noise map: https://www.bts.gov/geospatial/national-transportation-noise-map · data: https://catalog.data.gov/dataset/noise-data-2020
- Noise-Planet / NoiseCapture: https://noise-planet.org/
- ESA WorldCover: https://esa-worldcover.org/en/data-access
- Meta/WRI canopy height: https://registry.opendata.aws/dataforgood-fb-forests/
- ShadeMap: https://shademap.app/about/
- Mapillary API: https://www.mapillary.com/developer/api-documentation · terms: https://www.mapillary.com/terms
- Panoramax: https://docs.panoramax.fr/ · https://wiki.openstreetmap.org/wiki/Panoramax
- Global Streetscapes: https://huggingface.co/datasets/NUS-UAL/global-streetscapes · https://ual.sg/project/global-streetscapes
- Wikimedia User-Agent policy: https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy · API etiquette: https://www.mediawiki.org/wiki/API:Etiquette · Wikidata licensing: https://www.wikidata.org/wiki/Wikidata:Licensing
- opening_hours.js: https://github.com/opening-hours/opening_hours.js
- BestTime comparison page: https://besttime.app/alternatives/safegraph

**Taiwan open data**
- Open Government Data License v1.0: https://data.gov.tw/en/license
- Taipei street trees: https://data.gov.tw/en/datasets/128274
- NPA A1 crashes: https://data.gov.tw/en/datasets/12818
- Taipei burglary points: https://data.gov.tw/dataset/130312
- Project Sidewalk Taipei API: https://sidewalk-taipei.cs.washington.edu/api
- YouBike 2.0 live: https://tcgbusfs.blob.core.windows.net/dotapp/youbike/v2/youbike_immediate.json
- TDX on data.gov.tw (licence example): https://data.gov.tw/en/datasets/161157
- SEGIS phone-signal population: https://segis.moi.gov.tw/STATCloud/Signal
