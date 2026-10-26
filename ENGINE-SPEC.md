# Map pack v0: engine spec (build contract)

Goal: an agent turns a plain map request ("help us pick a hotel in Taipei", "make all railways green")
into an interactive, editable, phone-friendly map **site** on the first try. The site is ordinary
static files the user owns and can reshape. The pack gives good defaults, not limits.

Everything below is the contract between the engine (front end), the scripts (data + tooling) and
the skill text. If you must deviate, document it in `reference/config.md` and keep both sides in sync.

## 1. Layout

```
map-pack/
  README.md                         how to try it, how to import into Instafy
  DATA-SOURCES.md                   human-facing review of data sources (licences, limits, prod path)
  ENGINE-SPEC.md                    this file
  skills/interactive-map/           the skill (import with /skills import <path> --start)
    SKILL.md                        < 8 KB. Procedure + rules. Details live in reference/
    scripts/uw.mjs                  zero-dependency Node >= 18 CLI (single file is fine; may split into scripts/lib/*.mjs)
    reference/config.md             full map.config.json reference
    reference/recipes.md            how-tos: recolour railways, add a layer, custom control, etc.
    reference/data-sources.md       short agent-facing list: which command for which data, limits, attribution
    starter/                        copied into a new site by `uw.mjs new <dir>`
      index.html                    loads engine; no build step
      map.config.json               the site's content + behaviour (agent edits this most)
      style.json                    basemap style (agent edits for colours; copied from OpenFreeMap Liberty)
      custom.js                     optional escape hatch (agent writes custom interactions here)
      data/                         GeoJSON/JSON written by scripts
      engine/                       kit-owned. Replaced by `uw.mjs upgrade`. Sites should not edit it.
        engine.js  engine.css  bridge.js
        vendor/maplibre-gl.js  vendor/maplibre-gl.css   (maplibre-gl@5.24.0, vendored, BSD-3)
  examples/                         finished example sites + index.html gallery (not in this repository)
```

Instafy git refuses `dist`, `build`, `target`, `node_modules`, `tmp`, `coverage` at any depth, so never
use those names. Pack limit: 256 files, 8 MiB per skill.

## 2. Site files

### 2.1 index.html
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, theme-color.
- Loads `engine/vendor/maplibre-gl.css`, `engine/engine.css`, `engine/vendor/maplibre-gl.js` (UMD, global `maplibregl`),
  then `<script type="module" src="engine/engine.js">`. All paths relative (site may be served under a sub-path or in an iframe).
- Title comes from config at runtime. Body is just `<div id="app"></div>`.

### 2.2 map.config.json (version 1)

```jsonc
{
  "version": 1,
  "title": "Where to stay in Taipei",
  "subtitle": "3 nights · late Oct",
  "view": { "center": [121.52, 25.05], "zoom": 13.5, "pitch": 0, "bearing": 0, "bounds": [[121.49, 25.02], [121.56, 25.08]] },
  "basemap": {
    "style": "style.json",
    "labels": "en",                       // "en" | "local" | "both"  (rewrites symbol text-field to prefer name:en / name_int / name:latin)
    "theme": "auto",                      // "light" | "dark" | "auto" (auto follows the time slider: day / dusk / night look)
    "terrain": false,                     // true = 3D toggle shows terrain (AWS terrarium DEM) + hillshade
    "relief": false,                      // true = soft hillshade in 2D too (implies terrain); "exaggeration": 1.35 in 3D
    "overrides": [                        // applied after style load, by layer-id regex or "kind" keyword
      { "layers": "rail", "paint": { "line-color": "#22c55e" } }
    ]
  },
  "time":  { "enabled": true, "default": 14 },          // time-of-day slider, hours 0-24 (0.5 steps)
  "vibe":  { "enabled": true, "default": 0.4, "grid": "feel" },  // calm (0) <-> lively (1) dial driving the grid layer
  "air":   { "enabled": true, "data": "data/air.json" },        // regional air chip, follows the time slider
  "layers": [
    { "id": "hotels", "title": "Hotels", "type": "points", "data": "data/hotels.geojson",
      "style": { "color": "#e11d48", "emoji": "🏨", "size": "l" },
      "label": "name", "group": "Stay", "visible": true,
      "list": true, "selectable": true, "compare": true,
      "card": { "subtitle": "{area}", "body": "{note}", "fields": ["cafes_10min", "nearest_mrt_m"] } },
    { "id": "cafes", "title": "Cafés", "type": "points", "data": "data/cafes.geojson",
      "style": { "color": "#a16207", "emoji": "☕", "size": "s" }, "cluster": true, "group": "Around" },
    { "id": "mrt", "title": "MRT", "type": "lines", "data": "data/mrt.geojson",
      "style": { "color": "{colour}", "width": 4 } },              // "{prop}" = data-driven from feature property, with fallback colour
    { "id": "walk", "title": "10-min walk", "type": "areas", "data": "data/walk.geojson",
      "style": { "color": "#3b82f6", "opacity": 0.14, "outline": true }, "linkedTo": "hotels" },
    { "id": "feel", "title": "Calm ↔ lively", "type": "grid", "data": "data/feel.geojson", "visible": true },
    { "id": "day1", "title": "Day 1 walk", "type": "route", "data": "data/day1.geojson",
      "style": { "color": "#7c3aed", "width": 5 }, "animate": true },
    { "id": "legs", "title": "Trip", "type": "legs", "data": "data/legs.geojson",
      "style": { "color": "#0ea5e9" } },                             // curved arcs between ordered stops (not track geometry)
    { "id": "busy", "title": "Busy spots", "type": "heat", "data": "data/nightlife.geojson", "weight": "weight" }
  ],
  "compare": { "layer": "hotels", "max": 3, "metrics": [
      { "key": "cafes_10min", "label": "Cafés ≤10 min", "better": "higher" },
      { "key": "nearest_mrt_m", "label": "To MRT", "unit": "m", "better": "lower" },
      { "key": "calm_night", "label": "Calm at night (est.)", "format": "pct", "better": "higher" } ] },
  "plan": { "title": "Plan", "days": [
      { "title": "Day 1 · Arrive", "text": "Check in, coffee on Chifeng St.",
        "focus": { "layer": "hotels", "id": "via-loft" }, "route": "day1", "time": 15,
        "items": [ { "text": "Fika at …", "ref": { "layer": "cafes", "id": "osm-n123" } } ] } ] },
  "notes": [ { "at": { "layer": "hotels", "id": "via-loft" }, "emoji": "🌙", "text": "Quiet lane after 22:00 (est.)", "time": [21, 24] } ],
  "votes": { "via-loft": { "up": ["Kim"], "down": [] } },    // written by the agent from chat; shown as chips
  "attribution": ["Air: Open-Meteo / CAMS"],
  "custom": "custom.js",
  "css": "custom.css"                       // optional site stylesheet, loaded after engine.css
}
```

Rules:
- Every layer field except `id`, `type`, `data` is optional with good defaults (palette, sizes, groups).
- `visible` default true; `group` groups toggles in the Layers tab; `list: true` puts features in the Places tab.
- `time: [from, to]` on a layer, note, or a feature property pair `time_from`/`time_to` (hours, may wrap past 24) shows it only in that window.
- `linkedTo: "<layerId>"`: features with property `for == <selected feature id>` show strongly; others faint; when nothing selected, all show faint
  (one origin: shown fully; override with `linkedIdle: "show" | "faint"`). Selecting a point frames its linked area.
- `cluster` may be `{ "radius": 46, "maxZoom": 15 }`.
- `notes[].at` is either a ref `{layer,id}` or `[lng,lat]` that came from a script (never invented).
- Unknown keys are ignored with a console warning (forward compatible).

### 2.3 Feature conventions (all GeoJSON written by scripts)
- Every feature: `properties.id` (string, unique in its file), `properties.name`. Optional: `name_en`, `emoji`, `color`,
  `note`, `url`, `kind`, `area`, `for`, `time_from`, `time_to`, `source`, numeric metrics (snake_case).
- OSM-derived ids: `osm-n123`, `osm-w456`, `osm-r789`. Agent-named items: slug (`via-loft`).
- Coordinates are WGS84 `[lng, lat]`, max 6 decimals.

### 2.4 custom.js (escape hatch)
```js
export default function setup(uw) {
  // uw.map is the MapLibre map. Anything goes.
  uw.on('select', ({ layer, id, feature }) => { /* … */ });
  uw.ui.addButton({ id: 'surprise', label: '🎲', title: 'Surprise me', onClick: () => uw.select('cafes', uw.random('cafes')) });
}
```
Engine API (also exposed as `window.uw` for debugging and tests):
`map, config, on(evt, fn), emit(evt, payload), select(layerId, id), clearSelection(), flyTo(target), setTime(h), setVibe(v),
setLayerVisible(id, bool), addLayer(def) (same shape as config layers; data may be a URL or a GeoJSON object), getFeatures(layerId),
random(layerId), ui.toast(text), ui.addButton({id,label,title,onClick}), ui.openSheet('places'|'plan'|'layers'|'compare'|'card')`.
`setFilter(layerId, fn|null)`, `refresh()`.
Events: `ready, select, clear, pick, nope, pin, time, vibe, layer, day, 3d, look`. A shared link's selection / day / pin
is applied after custom.js has run.

### 2.5 Engine behaviour

**Rendering**
- Points: emoji icons must be rasterised with a canvas and `map.addImage` (SDF glyph fonts cannot draw emoji). Coloured
  circle badge + emoji; sizes s/m/l; selected = larger + ring + subtle pulse. `cluster: true` uses GeoJSON clustering
  with count bubbles that zoom in on tap.
- Lines: width/colour/dash; `{prop}` colour with fallback. Casing for legibility.
- Areas: fill + outline. Grid: the feel layer (see 2.6). Heat: MapLibre heatmap, fades out at high zoom into points.
- Route: line + direction arrows; "Walk it ▶" animates a dot along the line (~6 s, camera follows); tap anywhere stops.
- Legs: ordered stops become gently curved arcs with an emoji mode badge at the midpoint (`mode`: train/hsr/bus/car/flight/ferry/walk)
  and `duration` label if present.
- Notes: small speech-bubble markers (DOM; a 0×0 marker element with the bubble hanging off it, 44 px hit area, 2 lines);
  they flip left or shrink to their emoji instead of covering the button column, the sheet, the edges or each other.
- Selection pulse: three pulses, then a static ring (an endless pulse repaints the map every frame).
- Basemap: `labels` rewrite; `overrides` (regex on layer id, or keywords `rail`, `water`, `roads`, `buildings`, `parks`, `labels`);
  day / dusk / night look driven by time slider when theme=auto (setPaintProperty on background, water, landuse/park,
  roads, buildings, label colours). Terrain: `raster-dem` from
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (encoding terrarium, maxzoom 15) + hillshade;
  3D button toggles terrain + pitch 60.

**UI (mobile first; must feel good on a phone)**
- Full-viewport map (`100dvh`, safe-area insets). No page scroll, no layout shift.
- Bottom sheet with three snap points (peek = header + sliders + tab bar, so the tabs are always discoverable; half; full)
  dragged with pointer events (touch + mouse), header tap toggles. On wide screens (≥ 900 px) it becomes a 380 px left
  side panel (300 px on short landscape phones).
- Camera: the map transform's padding stays 0. Fits pass the sheet/panel as fit padding; point flights pass an
  `offset`. (MapLibre adds stored padding to every later fit, which double-counted the sheet.) Fits never throw.
- Sheet header (always visible in peek): title, subtitle, and the compact time slider ("🌞 14:00") and vibe dial
  ("Calm ●──── Lively") when enabled; air chip ("PM2.5 12 · Good", regional) when enabled.
- Tabs: Places (searchable list from `list: true` layers; tap = fly + select), Plan (days stepper with prev/next;
  step flies to focus, sets time, shows route), Layers (grouped toggles with legend swatches), Compare (when configured).
- Selected feature card (in the sheet, not a MapLibre popup on mobile): emoji, name, subtitle, body, metric bars
  (from `card.fields` and compare metrics), votes chips, actions: 👍 Pick, 👎 Nope, "Walk it" (if a route/isochrone is
  linked), "Open in Maps" (external link to Google/Apple maps search by name + coords), share.
- Floating buttons (right edge, ≥ 44 px): locate me (geolocation; graceful failure), 2D/3D, reset view, plus any custom buttons;
  a compass appears when the map is rotated (tap = north up).
- Long-press on map (touch, 500 ms) / right-click (desktop): drops a temporary pin; card shows "What's it like here?" with the
  feel breakdown of that cell; emits `pin`.
- Gestures: MapLibre defaults (pinch zoom, rotate, two-finger tilt); controls use `touch-action: manipulation`; nothing
  depends on hover. Tap targets ≥ 44 px. Works portrait and landscape.
- URL hash keeps state: `#t=22&v=0.3&s=hotels:via-loft&off=cafes,busy&d=2&@=121.52,25.05,14.2` (shareable).
- Light/dark UI chrome via prefers-color-scheme; `prefers-reduced-motion` disables flights/pulses/animation.
- Robustness: a failing data file shows a toast and the rest still renders; no WebGL shows a friendly message.
  Set `window.__uwReady = true` once the map is idle and all layers are added; push errors to `window.__uwErrors`.
- Votes: Pick/Nope stored in localStorage per site; merged with `config.votes` chips; each click emits `pick`/`nope`.
- Attribution: compact control with © OpenStreetMap contributors, OpenFreeMap, plus config and per-layer `attribution`.

**Bridge (engine/bridge.js)**
`emit(type, payload)` → if embedded (`window.parent !== window`) `parent.postMessage({ source: 'instafy-map', v: 1, type, payload, title }, '*')`;
always dispatch `window` CustomEvent `uw:event`. Event payloads carry layer, id, name and (for pin) `[lng,lat]`. This is how
Instafy will later turn clicks into attributed chat messages. No-ops safely outside a frame.

### 2.6 The feel grid (estimated; label it so in UI)
Cells written by `uw.mjs feel` carry 0-1 sub-scores (percentile within the area): `calm_day`, `calm_night`, `lively_day`,
`lively_night`, `green`, `amenities`, plus raw counts `n_cafe`, `n_food`, `n_gym`, `n_night`, `n_trees`.
Engine score at time h and vibe v: `night = h < 6 || h >= 19`; `score = (1-v)*calm_t + v*lively_t`, then
`score = 0.85*score + 0.15*green`. Colour ramp: transparent-ish grey (low) → teal → vivid green (high), opacity ≈ 0.45,
recolours live while dragging the dial or time (use feature-state or a data expression with a variable; avoid re-adding sources).
Tapping a cell shows the breakdown with an "estimated from OpenStreetMap" note.

## 3. Scripts: `node scripts/uw.mjs <command>` (zero dependencies, Node >= 18 global fetch)

General: `--json` for machine output; otherwise 1-3 human lines. Writes only inside the given site dir. Never overwrites
user files without `--force`, except files a command owns (its own `--layer` output). Network etiquette:
- `User-Agent: instafy-map-pack/0.1 (+https://instafy.dev)`. **Do not send `Accept: application/json` to Overpass** (it returns 406).
- Retry with exponential backoff on 429/5xx/timeouts; Overpass endpoint fallback list (overpass-api.de first).
- Min 1 s between Overpass requests (process-wide lock file in os.tmpdir is fine); cache raw responses in `<dir>/.uwcache/`
  keyed by request hash (and add `.uwcache/` to a `.gitignore` in the site).
- Cap area: refuse bbox > 60 km² for `places`/`feel` unless `--force-large`; `lines` allows larger with `--simplify`.

Commands:
| Command | Does |
|---|---|
| `new <dir> [--title] [--center lng,lat] [--zoom z] [--force]` | Copy `starter/` into dir; set title/view in config; add `.gitignore` |
| `doctor [<dir>]` | Node version, reachability of each service, Playwright availability, config sanity |
| `geocode "<q>" [--near lng,lat] [--limit 5]` | Photon (`photon.komoot.io`) candidates: name, type, address, `[lng,lat]`, osm id. Biased with `lat/lon` when `--near` |
| `add-point <dir> --layer <id> --query "<q>" [--near lng,lat] [--id slug] [--emoji] [--props JSON] [--pick N]` | Geocode and append/replace a point in `data/<layer>.geojson`; prints what it chose and alternatives; `--osm <id>` adds an exact OSM object; `--at lng,lat` only for coordinates given by the user. Refusals list OSM objects carrying the name as old/alt name |
| `set <dir> <layer>:<id> [--note] [--name] [--props JSON] [--unset k] [--remove]` | Edit one feature's properties (or remove it) without any network call |
| `places <dir> --layer <id> --kinds cafe,gym,… \| --tag k=v [--near lng,lat --radius m \| --bbox w,s,e,n] [--name-match re] [--limit N]` | Overpass → points with normalised props (id, name, name_en, kind, emoji, opening_hours, website, cuisine, brand) |
| `lines <dir> --layer <id> --kinds subway,rail,hsr,tram,light_rail,ferry,cycleway [--bbox] [--simplify m]` | Overpass → lines with name, ref, `colour` (from OSM `colour` tag, route relations preferred for transit) |
| `route <dir> --layer <id> --from <pt> --to <pt> [--via <pt>…] [--mode foot\|bike\|car] [--name]` | FOSSGIS OSRM (`routing.openstreetmap.de/routed-{foot,bike,car}`) → line with `duration_min`, `distance_km`. `<pt>` = `lng,lat` or `layer:id` |
| `isochrone <dir> --layer <id> (--from layer:<layerId> \| --from lng,lat) [--minutes 10] [--mode foot\|bike]` | Valhalla FOSSGIS (`valhalla1.openstreetmap.de/isochrone`) → polygons with `for` = source feature id, `minutes` |
| `legs <dir> --layer <id> --stops "layer:id,layer:id,…" [--modes train,hsr,…] [--durations "1h45,…"]` | Ordered stop-to-stop features (LineString of 2 points + props) for the `legs` layer type |
| `air <dir> (--at lng,lat \| --from layer:<layerId>)` | Open-Meteo air quality (pm2_5, pm10, nitrogen_dioxide, european_aqi, us_aqi; past 7 + forecast 3 days) → `data/air.json` incl. hour-of-day averages per location |
| `feel <dir> --bbox w,s,e,n [--cell 200]` | One Overpass pull (major roads, above-ground rail, runways, green areas, trees, POIs, nightlife) → `data/feel.geojson` + `data/feel.meta.json` (method, sources, date). Noise is an estimate from road class/rail/airport distance (+ nightlife at night). Percentile-normalised within the bbox |
| `enrich <dir> --layer <id> [--within <isochroneLayer>] [--count cafes,gyms,…] [--nearest <layerId>] [--feel]` | Adds metrics to each feature: `<layer>_10min` counts inside its linked isochrone (or radius), `nearest_<layer>_m`, feel sub-scores at its cell |
| `wiki <dir> --layer <id> --near lng,lat [--radius m] [--lang en]` | Wikipedia geosearch → points with title, url, short extract |
| `validate <dir>` | Config schema, every layer file exists + valid GeoJSON + ids/names present, coordinates within view bounds (+ margin) and not [0,0], refs in plan/notes/compare resolve, style.json parses, custom.js passes `node --check`, size budget. Agent-actionable messages; exit 1 on error |
| `serve <dir> [--port 4173] [--host 0.0.0.0]` | Static server with Range (206) support, correct MIME, no-cache, never serves dotfiles; listens on 127.0.0.1 unless `--host 0.0.0.0` (then prints the LAN URL) |
| `snapshot <dir> [--out <dir>/snapshots] [--only desktop\|mobile] [--eval js] [--tag name] [--thumb]` | Starts its own server on a free port; Playwright (try `import('playwright')`, then `$UW_PLAYWRIGHT` module path; `channel: 'chrome'` if no bundled browser) renders desktop 1280×800 and mobile 390×844 (isMobile, hasTouch, DPR 2); waits for `__uwReady`; `--eval` runs JS first; writes PNGs; prints console errors; exit 1 on errors. Without Playwright: exit 3 and stale PNGs removed |
| `upgrade <dir>` | Replace `engine/` from the pack's starter (kit-owned files only) |

Playwright 1.61.1 (pointed to with `UW_PLAYWRIGHT` when it is not importable) works with `channel: 'chrome'` and args
`--use-angle=swiftshader --enable-unsafe-swiftshader` (WebGL OK, touch emulation OK).

## 4. Skill (SKILL.md) essentials
Frontmatter: `name: interactive-map`, `description`, `routing_keywords` (map, maps, route, walk, neighbourhood, area,
hotel, trip, travel, itinerary, places, nearby, pins, layers, railways, air quality, pollution, noise, quiet),
`context_parent: instafy-skill-router`. Body: when to use; the procedure (new → data via scripts → config → custom only if
needed → validate until exit 0 → snapshot and look at both PNGs → serve/preview → short reply with 2-4 follow-up ideas);
hard rules (never type coordinates or invent places — every point comes from a script; label estimates; keep sources/attribution;
edit `map.config.json`/`style.json`/`custom.js`, never `engine/`); pointers into `reference/`. A `## Getting started`
section for `/skills import … --start` (check Node, run `doctor`, offer to build a demo map of the user's city).
In Instafy, preview via `uw.mjs serve` + `instafy preview open` (Instafy `docs/Previews.md`).
