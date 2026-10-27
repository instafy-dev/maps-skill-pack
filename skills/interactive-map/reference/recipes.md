# Recipes

Short how-tos. `uw` = the pack's command (on PATH in every shell; see SKILL.md), `S` = the site folder. After
each one: `uw validate S`, then `uw snapshot S` and look at both PNGs. Full key list: `config.md`.

## 0. Full example (v0.2): "which of these 2 hotels?" with a verdict
This is the flow the pack's smoke test runs (11 Oct 2026, Taipei), in fast-first order: Phase A gives a lettered
map with a verdict and a preview link in a few minutes; Phase B steps refine it (each may exit 4 = skipped when a
service is busy: the map stays valid; re-run the same `question` command after each). Coordinates come from commands.
```sh
# Phase A
uw geocode "Datong District, Taipei"                    # → 121.515514,25.065986
uw new S --title "Which Taipei hotel?" --center 121.515514,25.065986 --zoom 13
uw add-point S --layer hotels --query "Via Hotel Loft, Taipei" --near 121.515514,25.065986 --id via-loft
uw add-point S --layer hotels --query "Lore Hotel, Taipei" --near 121.515514,25.065986 --id lore
#   not in OSM: found in Taiwan's lodging register (樂爾公寓, licence 臺北市旅館166號); registers "hotels" (tier option)
#   and frames the view. Outside Taiwan, ask for the address: --query "<street part>" --name "…" --kind hotel
uw places S --layer mrt --kinds mrt_station --around hotels --radius 800     # each command registers its layer
uw places S --layer cafes --kinds cafe --around hotels --radius 800
#   Overpass busy: both come from the places chain's fallback ("From OpenStreetMap search (Photon) …", exit 0); other kinds exit 4 (go on)
uw enrich S --layer hotels --route-to mrt --nearest mrt --count cafes          # walk_min_mrt, nearest_mrt_m, cafes_800m
uw question S --kind choose-one --options hotels --criteria quiet_night_blocks:3,walk_min_mrt:2,noise_night_db:1,lively_night_blocks:0 \
   --lenses sleep,night,move --lens sleep --ask "Which hotel for 3 quiet nights near the MRT?" --force
#   → walk_min_mrt now; quiet_night_blocks, noise_night_db, lively_night_blocks and the sleep/night lenses "pending".
#   "NOTHING MEASURED YET SEPARATES THE OPTIONS" (e.g. only a café count, all 20+): too close to call; measure more
uw fit S && uw validate S --signal && uw serve S --host 0.0.0.0 &                # preview link now
# Phase B (one at a time; after each: the same question command, then validate)
uw snapshot S --signal
uw adapter tw-hotels S --layer hotels --records                                # Taiwan only: licence + filed rates
uw isochrone S --layer walk --from layer:hotels --minutes 10
uw feel S --around hotels                                                      # cells within 700 m of each hotel
uw enrich S --layer hotels --feel --feel-within walk
uw areas S --lens quiet_night,lively_night --within walk --options hotels      # quiet_night_blocks, lively_night_blocks
uw adapter tw-night-markets S --around hotels --radius 1500 --add-osm            # Taiwan: markets + permitted hours
uw enrich S --layer hotels --nearest nightmarkets
uw doorstep S --layer hotels
uw photos S --layer hotels
```
What the commands wrote into `map.config.json` (no hand edits; `time` and `bind` are yours):
```json
"time": { "enabled": true, "default": 14 },
"vibe": { "enabled": true, "default": 0.4, "grid": "feel" },
"photos": { "layers": ["hotels"] },
"bind": true,
"layers": [
  { "id": "feel", "title": "Calm ↔ lively (est.)", "type": "grid", "data": "data/feel.geojson" },
  { "id": "walk", "title": "10-min walk", "type": "areas", "data": "data/walk.geojson", "linkedTo": "hotels" },
  { "id": "areas", "title": "Areas (est.)", "type": "areas", "data": "data/areas.geojson", "role": "verdict" },
  { "id": "mrt", "title": "Metro stations", "type": "points", "data": "data/mrt.geojson", "style": { "emoji": "🚇" } },
  { "id": "hotels", "title": "Hotels", "type": "points", "data": "data/hotels.geojson", "tier": "option", "style": { "emoji": "🏨" }, "list": true } ]
```
Then `bound.json` (recipe 27) and `uw host S --host 0.0.0.0` instead of `serve`.
The peek reads one line per hotel, each kind of guest's pick with its reason: `A Via Loft · best for light sleepers:
quietest door at night, tied with C, and 4 quiet blocks nearby (C 0) · Estimate` / `B Lore · best for commuters:
closest MRT, 3 min · but night market 262 m away (18:00–00:00)` / `C Everstar · best for night owls: liveliest streets
nearby · Estimate`.
A is the best match (letters follow the rank under the starting lens). Nothing in it was typed by hand.

## 1. Make all railways green
`map.config.json` → `basemap.overrides`:
```json
{ "layers": "rail", "color": "#22c55e", "width": 2.5 }
```
`rail` is a keyword (all basemap rail line layers). Other keywords: `water`, `roads`, `buildings`, `parks`,
`labels`, `pois`, `boundaries`, `landuse`, `background`; or a regex on `style.json` layer ids.
`rail` also matches the white `*_hatching` dashes and the tunnels, which then turn into green dots. For a clean look:
```json
{ "layers": "rail.*hatching", "visible": false },
{ "layers": "^(road|bridge)_.*rail$", "paint": { "line-color": "#22c55e", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 16, 4.5] } },
{ "layers": "^tunnel_.*rail$", "paint": { "line-color": "#22c55e", "line-opacity": 0.55, "line-dasharray": [2, 1.5] } }
```
Bolder tracks at city zoom: add an OSM overlay too (`uw lines S --layer rail --kinds rail,subway,tram`,
`"style": { "color": "#22c55e" }`, recipe 2).

## 2. MRT / metro in its real line colours
```sh
uw lines S --layer metro --kinds subway --around hotels --radius 2500
```
```json
{ "id": "metro", "title": "MRT lines", "type": "lines", "data": "data/metro.geojson", "style": { "color": "{colour}", "width": 4 } }
```
`{colour}` reads each line's OSM colour; the fallback is the palette. Country-wide rail: `--kinds rail,hsr --simplify 80`.

## 3. Labels in English (or both)
`"basemap": { "labels": "en" }` (English where OSM has it, else local), `"both"` (English + local), `"local"`.
Your own point labels: `"label": "name"` uses `name_en` when present.

## 4. Dark, minimal look
```json
"basemap": { "theme": "dark", "overrides": [
  { "layers": "pois", "visible": false },
  { "layers": "^building", "opacity": 0.3 },
  { "layers": "roads", "opacity": 0.7 } ] }
```
`"theme": "auto"` + a time slider instead gives day → dusk → night as the slider moves.

## 5. Hide POI clutter / a clean, minimal basemap
`{ "layers": "pois", "visible": false }` in `basemap.overrides`. Only the user's own layers keep icons.
Quieter roads: mute them with zoom-dependent opacity (a fixed `color` would also freeze them through the night look):
```json
{ "layers": "roads", "opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.35, 14, 0.6, 17, 0.85] },
{ "layers": "^(highway-shield|road_shield)|one_way", "visible": false },
{ "layers": "^building", "opacity": 0.45 }
```

## 6. A coffee layer (independent cafés)
```sh
uw places S --layer cafes --kinds coffee --around hotels --radius 1000            # cafés minus bubble tea / tea / juice
uw places S --layer cafes --kinds coffee --no-brands --around hotels --radius 1000 # independents only (no chain brand)
uw places S --layer cafes --kinds coffee --within walk                            # only inside the 10-min walk areas
```
`--kinds cafe` is every `amenity=cafe` (chains and bubble tea included; cannabis coffeeshops are always left out).
OSM has no ratings: say the picks are by tags ("independent, listed hours"), not taste.
```json
{ "id": "cafes", "title": "Cafés", "type": "points", "data": "data/cafes.geojson",
  "style": { "color": "#a16207", "emoji": "☕", "size": "s" }, "cluster": true, "group": "Around" }
```
Use `cluster` above ~80 points. Change the badge with `style.emoji` / `style.color`; no refetch needed.

## 7. 10-minute walk bubble per hotel
```sh
uw isochrone S --layer walk --from layer:hotels --minutes 10
```
```json
{ "id": "walk", "title": "10-min walk", "type": "areas", "data": "data/walk.geojson",
  "style": { "color": "#3b82f6", "opacity": 0.14 }, "linkedTo": "hotels" }
```
Put it before `hotels` in `layers` (drawn underneath). Selecting a hotel highlights its own area and frames it;
the card gets a "10-min walk" button. With several hotels the areas are faint until one is selected; with one
origin (a station, a park) it shows fully. Override with `"linkedIdle": "show"` or `"faint"`. Bike rings:
`--mode bike --minutes 5,10,15`.

## 8. Compare hotels
```sh
uw enrich S --layer hotels --count cafes,gyms --nearest gyms --route-to mrt --feel --feel-within walk
```
`--feel` scores the 200 m block at the door; `--feel-within walk` averages the whole 10-min walk area
(`calm_night_area`…), usually the fairer "how calm is it around here". `--route-to mrt` = walking minutes by the
street network (`walk_min_mrt`). Needs walk (7) and feel (18).
The output prints the metric keys and a ready `compare.metrics` list. Pick 3-5:
```json
"compare": { "layer": "hotels", "max": 3, "metrics": [
  { "key": "cafes_10min", "label": "Cafés ≤10 min walk", "better": "higher" },
  { "key": "nearest_mrt_m", "label": "To MRT", "unit": "m", "better": "lower" },
  { "key": "calm_night", "label": "Calm at night (est.)", "format": "pct", "better": "higher" } ] }
```
Keep "(est.)" on feel metrics. Re-run `enrich` after changing hotels, cafés or walk areas.

## 9. Day plan with walking routes
```sh
uw route S --layer day1 --from hotels:regent --via cafes:osm-n10161164616 --to sights:wiki-123 --name "Day 1 walk"
uw route S --layer day2 --from hotels:regent --to cafes:osm-n3200943837 --name "Day 2 coffee"
```
Each day gets its own route layer (`"type": "route"`), or one layer with one route per hotel
(`route … --append`: a day whose `focus` is a hotel walks that hotel's route), then:
```json
"plan": { "days": [
  { "title": "Day 1 · Old town", "time": 10, "focus": { "layer": "hotels", "id": "regent" }, "route": "day1",
    "items": [ { "text": "Coffee", "ref": { "layer": "cafes", "id": "osm-n10161164616" } } ] },
  { "title": "Day 2", "time": 9, "route": "day2" } ] }
```
Route layers named in the plan show only on their day; "Walk it ▶" animates them ("Ride it" for `--mode bike`).
Opening the plan tab shows day 1 on the map; "Show on map" re-applies a day.

## 10. Trip legs + 3D terrain
```sh
uw add-point S --layer stops --query "Taipei Main Station" --id taipei --near <lng,lat from geocode>
uw add-point S --layer stops --query "Hualien Station" --id hualien --near <…>
uw add-point S --layer stops --query "Tainan Station" --id tainan --near <…>
uw legs S --layer trip --stops stops:taipei,stops:hualien,stops:tainan,stops:taipei --modes train,train,hsr \
   --durations "2h10,3h30,1h45" --source "TRA/THSR timetable"
uw fit S
```
```json
"basemap": { "terrain": true, "relief": true, "exaggeration": 1.5 },
"layers": [ { "id": "trip", "title": "Trip", "type": "legs", "data": "data/trip.geojson", "style": { "color": "#0ea5e9" } },
            { "id": "stops", "title": "Stops", "type": "points", "data": "data/stops.geojson", "label": "name" } ]
```
Durations only from the user or a timetable (else leave `--durations` out; put "check the TRA / THSR timetables"
in the layer `legend`). `relief` keeps a soft hillshade in 2D; the 3D button tilts into real terrain. Legs are arcs
in trip order: the card says "≈ N km straight line". On the real track instead: `uw lines S --layer rail --kinds
rail,hsr --simplify 80` (and `--kinds heritage` for tourist lines such as the Alishan Forest Railway), then
`uw legs … --follow rail`. A whole trip with stations, stays by the station and a dated plan: `itinerary.md`.

## 11. Night markets that only glow at night
Taiwan (Taipei open data with real hours, plus Shilin from OSM):
```sh
uw adapter tw-night-markets S --around hotels --radius 1500 --add-osm      # → data/nightmarkets.geojson
```
`--around` keeps markets within the radius of ANY hotel (a circle each, not the box around all of them).
```json
"time": { "enabled": true, "default": 20 },
"layers": [ { "id": "nightmarkets", "title": "Night markets", "type": "points", "data": "data/nightmarkets.geojson",
  "style": { "color": "#dc2626", "emoji": "🏮", "glow": true }, "label": "name" } ]
```
Each market has `time_from`/`time_to` (e.g. 18 → 24) and `hours_text`; `glow` lights it up only during its window.
The adapter appends the mandatory credit `夜市資料：臺北市政府市場處 (data.gov.tw，政府資料開放授權條款第1版)`.
Elsewhere: `uw places S --layer markets --kinds night_market --around hotels --radius 3000` and a layer
`"time": [17, 25]` (simple `opening_hours` already give each market its window).

## 12. Nightlife heat
```sh
uw places S --layer nightlife --kinds bar,nightclub,karaoke --around hotels --radius 1500
```
```json
{ "id": "busy", "title": "Busy at night", "type": "heat", "data": "data/nightlife.geojson", "time": [18, 27] }
```
A heat layer fades into dots when zoomed in. Use `"weight": "<numeric prop>"` to weight points.

## 13. A custom button (custom.js)
```js
export default function setup(uw) {
  uw.ui.addButton({ id: 'surprise', label: 'Pick', title: 'Surprise me', adjust: 'Surprise me', onClick: () => {
    const id = uw.random('cafes'); if (id) uw.select('cafes', id);
  } });
}
```
Buttons join the right-edge column; keep labels to 2-4 letters (no emoji). With `adjust` (a word), a question map
puts the button in Adjust instead, so the map keeps only what people need at once.

## 14. React to 👍 Pick / 👎 Nope
```js
export default function setup(uw) {
  uw.on('pick', ({ layer, id, name, on }) => { if (on) uw.ui.toast(`Added ${name} to the shortlist`); });
  uw.on('nope', ({ layer, id, on }) => { if (on && layer === 'hotels') uw.setLayerVisible('walk', true); });
}
```
Votes from chat go in `"votes": { "regent": { "up": ["Kim"], "down": [] } }` (chips on cards and lists).
Inside an iframe every event is also posted to the parent (`source: 'instafy-map'`).

## 15. Share a link to the exact state
The URL hash always holds time, vibe, selection, pin, toggled layers, plan day and camera, so the Share button
(or copying the address bar) reproduces the view. Build one yourself:
`index.html#t=22&v=0.8&s=hotels:regent&off=cafes&d=1&@=121.523,25.053,15.5`.

## 16. Wikipedia sights with photos
```sh
uw wiki S --layer sights --near hotels:regent --radius 1500 --limit 20
```
```json
{ "id": "sights", "title": "Sights", "type": "points", "data": "data/sights.geojson",
  "style": { "color": "#475569", "emoji": "📖", "size": "s" }, "visible": false }
```
Cards show the extract, a thumbnail with its author and licence, and a Website link; the CC BY-SA credit comes
from the file. List articles, disambiguations, schools and embassies are left out; `--exclude "station|MRT"` drops more.
Several towns in one layer: one call per town with `--append`.

## 17. Air quality chip
```sh
uw air S --from layer:hotels          # or --at lng,lat --name "Taipei"
```
`"air": { "enabled": true, "data": "data/air.json" }`. Say "regional model" when you mention it. The command
says when all points share one model cell (then air can't tell hotels apart) and which dates the hour-of-day
averages cover (the last week + 3-day forecast, not the trip dates).

## 18. Calm ↔ lively feel grid
```sh
uw feel S --around hotels           # cells within 700 m of each hotel (--radius); ~20-60 s, skipped past 90 s
uw feel S --around hotels --box     # the old rectangle around all of them (+800 m); ≤ 60 km²
```
```json
"vibe": { "enabled": true, "default": 0.4, "grid": "feel" },
"layers": [ { "id": "feel", "title": "Calm ↔ lively (est.)", "type": "grid", "data": "data/feel.geojson" }, … ]
```
Put the grid first (bottom). Long-press anywhere for "What's it like here?". Rivers and lakes get no score
(cells marked `water`); the sea is not detected.

## 19. A named district ("calm, leafy parts of Da'an")
```sh
uw geocode "大安區, 臺北市"                                   # a district is a point in Photon, not a boundary
uw add-point S --layer district --query "大安區" --pick 1    # anchor point; hide it: "visible": false, "list": false
uw feel S --around district --radius 2000                   # a box around the point, not the district outline
uw places S --layer parks --kinds park --around district --radius 1500
uw fit S --layers coffeewalk,picks,station                  # frame the walk, not the whole grid
```
Say that the grid is a box around the district centre (it spills into neighbouring districts).

## 20. Check a tab, a card or a day without writing a script
```sh
uw snapshot S --only mobile --eval "uw.ui.openSheet('compare')" --tag compare
uw snapshot S --only mobile --eval "uw.setDay(2)" --tag day3
uw snapshot S --only mobile --eval "uw.select('hotels','regent')" --tag card
```
Writes `snapshots/mobile-<tag>.png`; look at it like the others.

## 21. Verdict strip (the answer in the sheet)
Never type it. Make the numbers (`enrich`, `areas`, adapters), then `uw question S --kind choose-one --options hotels
--criteria key:3,key:2[,key:0] --lenses sleep,night --lens sleep --ask "…"`. Each criterion needs a value on ≥ 2
options that differ (validate V6). Tune the words in `question.criteria[].phrase` (`lead` when the option is the only
leader, `value` with `{value}`, `worst` when it is the worst of them, `zero`). Each fact shows its own basis (`est.`,
🧭, 📏…); a caveat ("but …") replaces the second fact so a line fits two phone lines. To pin a hand line, it needs
`cites` and its numbers must equal the data:
```json
"verdict": { "mode": "auto", "lines": [ { "ref": "hotels:lore", "pin": true, "text": "MRT 3 min · quietest lanes (est.)",
  "cites": ["walk_min_mrt", "quiet_night_blocks"] } ] }
```

## 22. Lettered options (A, B, C)
`question.options.layer` makes that layer's features lettered 40 px pins (never hidden by collisions), in
`options.ids` order. `uw question` writes `ids` by rank under the starting lens (A = the best match; letters stay put
across lenses; `--letters given` keeps your order). Keep 2-5 options. Everything else becomes
support (≤ 10 badges) or context (dots). Too much on the map? `"tier": "context"` on the layer, or
`question.budget: { "support": 6 }`. `uw snapshot S --signal` reports the noise (S1) per state.

## 23. Named areas ("Quiet at night · Dadaocheng Park")
Needs a feel grid and 10-min walk areas:
```sh
uw areas S --lens quiet_night,lively_night --within walk --options hotels
uw areas S --lens quiet_night,lively_night --within walk --options hotels --force --names '{"quiet_night-1":"Dadaocheng back lanes|大稻埕巷弄"}'
uw areas S --lens green,quiet_day --near coffeewalk --radius 400          # only pockets along a walk or route
```
Names: a park inside, a neighbourhood, else the longest street inside (never the main road through a quiet area).
Quiet lenses leave out blocks next to a night market open in their hours (automatic with a night-market layer;
`--avoid layer:metres`). The `<lens>_blocks` numbers on the options count the drawn areas' cells, so they can be
checked on the map.
Add `{ "id": "areas", "type": "areas", "data": "data/areas.geojson", "role": "verdict" }`. Areas show only for the
active lens and inside their time window (quiet at night 19-06), so give the question a starting lens. "Area n"
names mean Overpass was busy: run it again later. The grid becomes an expert layer ("Show the evidence").

## 24. Doorstep photos + link-outs
```sh
uw doorstep S --layer hotels        # Street View ↗ / Look Around ↗ face the door
uw photos S --layer hotels          # Panoramax, ≤ 40 m, dated, credited
```
`photos` adds `"photos": { "data": "data/photos.json", "layers": ["hotels"] }` to the config. A hotel without a photo shows one row "No street photo within 40 m
(nearest 106 m) · Street View ↗" (honest; never swap in a farther one). Pictures taken from a bridge or expressway
beside the door's street are left out ("the 4 within 40 m are from an elevated road"). Link-out row: `"links": { "show": ["streetview", "google", "apple"] }`.

## 25. Licence chip (Taiwan hotels)
```sh
uw adapter tw-hotels S --layer hotels --records
```
Writes `licence`, `tw_*` props, `data/records/tw-hotels.json` (claims: licence, registered rooms, filed min/max rate)
and the mandatory OGDL credit. Cards show `✓ Registered hotel · 臺北市旅館166號` and "Checked facts"
`Filed max rate NT$15,000 · Taipei hotel register · 9 Sep 2026` (a legal ceiling, not a price). A miss reads "Not found
in register", never a negative word. The first run downloads ~5 MB (30-60 s); later runs and `uw host` are instant.

## 26. Night-market glow
See recipe 11 (`uw adapter tw-night-markets`, `"glow": true`). Cards say "Permitted vendor hours 18:00–00:00 ·
Taipei Markets Office · 18 Mar 2026 🏛 registry" (a vendor-zone permit, not opening hours); OSM-only markets say
"Hours not listed". `uw enrich S --layer hotels --nearest nightmarkets` + `uw question` add a `watch`: a market within
400 m becomes a ✗ line on the card and the Sleep lens caveat ("but night market 262 m away (18:00–00:00)").

## 27. Add an intent + handler ("make the map do things")
1. `bound.json` at the site root (one intent per button; full shape in `config.md` "bound.json and intents"):
```json
{ "version": 1,
  "intents": { "count_nearby": {
    "label": "Count MRT nearby", "emoji": "🚇",
    "params": { "type": "object", "required": ["ref"], "additionalProperties": false, "properties": {
      "ref": { "type": "string", "maxLength": 120 }, "layer": { "type": "string", "enum": ["mrt"], "default": "mrt" },
      "radius_m": { "type": "integer", "minimum": 100, "maximum": 2000, "default": 800 } } },
    "prefill": { "ref": "$item.ref" }, "ui": ["card-more"], "layers": ["hotels"],
    "target": { "records": "data/records/count_nearby.json", "layer": "hotels" },
    "pending": "item", "cooldown_s": 5, "timeout_s": 30, "sources": ["site:mrt"], "handler": "handlers/count_nearby.mjs" } },
  "results": { "files": ["data/records/count_nearby.json"] } }
```
2. `"bind": true` in `map.config.json`.
3. `handlers/count_nearby.mjs`: reads one JSON object on stdin (`{ intent: { id, name, params }, bound, site: { dir,
   config } }`) and prints NDJSON lines: `progress`, `records` (any number), then `done` or `error`. It never writes
   site files; `uw host` validates each record, keeps only `sources` and lanes open/official/local, stamps
   `prov.intent`, merges into `target.records` and bumps `data/version.json`.
```js
import fs from 'node:fs';
import path from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { ref, layer = 'mrt', radius_m = 800 } = input.intent.params;
const [itemLayer, itemId] = ref.split(':');
const read = (id) => JSON.parse(fs.readFileSync(path.join(input.site.dir, 'data', `${id}.geojson`), 'utf8'));
const item = read(itemLayer).features.find((f) => String(f.properties.id) === itemId);
if (!item) { out({ type: 'error', code: 'not_found', message: `${ref} is not on this map` }); process.exit(0); }
out({ type: 'progress', step: 1, of: 1, message: `Counting ${layer} within ${radius_m} m`, source: `site:${layer}` });
const [x0, y0] = item.geometry.coordinates;
const dist = ([x, y]) => 6371000 * Math.hypot((x - x0) * Math.PI / 180 * Math.cos(y0 * Math.PI / 180), (y - y0) * Math.PI / 180);
const n = read(layer).features.filter((f) => f.geometry.type === 'Point' && dist(f.geometry.coordinates) <= radius_m).length;
out({ type: 'records', records: [{ type: 'claim', cid: `clm_${itemId}_${layer}_${radius_m}m`, ref, attr: `${layer}_${radius_m}m`,
  value: n, label: `${layer.toUpperCase()} within ${radius_m} m`, basis: 'counted', confidence: 'medium',
  prov: { source: `site:${layer}`, source_label: 'OpenStreetMap (this map)', lane: 'local', observed_at: new Date().toISOString(), ttl_s: 604800 } }] });
out({ type: 'done', summary: `${n} ${layer} within ${radius_m} m` });
```
4. `uw validate S --signal` (checks the schema subset, prefill tokens, ui values, handler path), then recipe 29.
Pack handlers need no file: `"handler": "pack:check_registry"` (licence, Taiwan) and `"pack:find_hotels_nearby"`
(`"ui": ["map-context", "card-more"]`, `"pending": "layer"`, `target.create` makes the 🏨 layer on first results).

## 28. Stream results to everyone viewing
Results are records, so every path ends the same way: `uw host` sends them over Server-Sent Events to every open
phone and writes them to `data/records/*.json` + `data/version.json` (late joiners and static hosts poll that file).
Inside Instafy the parent frame answers over postMessage. From `custom.js` or a test, feed a host message directly:
```js
uw.ingest({ type: 'results', records: [ /* uw.records@1 records */ ] });
uw.on('results', ({ id, count, refs }) => uw.ui.toast(`${count} new facts`));
```
Records are untrusted: the engine validates them (schema, https URLs, ≤ 200 KB per file) and renders text only.

## 29. Run the loop locally: `uw host`
```sh
uw host S --host 0.0.0.0            # prints local + LAN URLs; intents with a resolvable handler are listed
uw host examples                    # a gallery: every subfolder with a bound.json gets <sub>/__uw/*
uw host S --confirm                 # each job waits for "y" in the terminal (like Instafy's confirm tray)
```
Open the URL on two phones, tap an option → 🪪 Check licence (in the card head): the chip shows a skeleton and
"Loading Taiwan hotel database · 1/2" (the other phone: "Someone else: Loading…"), then `✓ Registered hotel ·
臺北市旅館166號` on both phones and the button reads "✓ Checked · now". `__uw/jobs` lists recent jobs.
Without a listener (plain `uw serve`, a static host) the buttons are absent, not greyed; `#bind=1` forces them.


## 30. Theme the chrome (Instafy, the old look, or your brand)
Sites get Instafy's look by default, the same as Instafy's plain pages (blue only on the filled button, links and
focus; neutral selection with a check; 8 px buttons; charcoal dark mode that follows Studio's theme; a charcoal night
map). Restyle only when the person asks. Pick a preset or add tokens in `map.config.json` (every token: config.md → theme):
```jsonc
"theme": "neutral"                                   // the pre-theme look (indigo accent, navy night)
"theme": { "radius-btn": "12px",                    // flat keys: every look
  "letter-a": "#0e7490",                            // drawn colours: top level, never inside light / dark
  "light": { "accent": "#0e7490", "accent-fill": "#0e7490", "accent-hover": "#155e75", "accent-soft": "#e3f3f7",
             "accent-ink": "#155e75", "link": "#155e75", "sel-bg": "#e3f3f7", "sel-fg": "#155e75", "sel-ring": "#0e7490",
             "tab-on-bg": "#e3f3f7", "tab-on-fg": "#155e75", "switch-on": "#0e7490", "me": "#0e7490" },
  "dark":  { "accent": "#22d3ee", "accent-fill": "#0e7490", "accent-hover": "#155e75", "accent-ink": "#67e8f9",
             "link": "#67e8f9", "sel-fg": "#67e8f9", "sel-ring": "#22d3ee", "tab-on-fg": "#67e8f9", "switch-on": "#0e7490" } }
```
Interaction colours (buttons, links, focus, active tab, selected chip) share one hue. Letter A may follow the accent
(as in the instafy preset), but no other letter may: here teal D (`#0f766e`) stays clear of the cyan accent; if your
accent lands on another letter's hue, move that letter too. Validate warns when two letters are within ~20 ΔE, and
when a layer colour looks like a letter in use (use `"color": "letter"` / `"walk"` for walk areas and routes). Tints and text colours go in
`light` / `dark` (a flat tint would sit under light text in dark mode); keep text ≥ 4.5:1 on the sheet in both.
Only restyling one element? Use `"css": "custom.css"` with `.uw-root { --uw-radius-btn: 12px; }`
(chrome tokens; drawn colours such as `letter-*` go in `"theme"`, see config.md → theme).
Check with `uw snapshot S --signal` (light), `--scheme dark --tag dark` and `--hash "t=22" --tag night` (the map goes
dark; the panels stay in the light / dark mode), and look.
