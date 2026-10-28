# map.config.json reference

The site's content and behaviour. The engine (`engine/`) reads it at load; there is no build step. Edit this file,
`style.json`, `custom.js` (and `custom.css` via `"css"`); never edit `engine/`. Run `uw validate <site>` after every edit.

Everything except `layers[].id`, `layers[].type` and `layers[].data` is optional. Unknown keys are ignored with a
console warning (validate warns too). Colours are any CSS colour (`#e11d48`, `rgb()`, `hsl()`, `green`); validate
rejects anything else.

```jsonc
{
  "version": 2,                              // 1 or 2 (same engine); 2 = this file uses v0.2 keys
  "locale": "sv",                            // en (default) | sv: words the map writes itself (tabs, verdict phrases from
                                             // uw question); set by uw new/question --lang. Your own texts: write them in it
  "title": "Where to stay in Taipei",          // page title + sheet header
  "subtitle": "3 nights · late Oct",
  "view": { … }, "basemap": { … },
  "time": { … }, "vibe": { … }, "air": { … },
  "layers": [ … ],
  "question": { … }, "verdict": { … },       // v0.2: what the map answers + the verdict strip
  "links": { … }, "photos": { … },           // v0.2: link-outs and doorstep photos on cards
  "bind": true, "intents": { … },            // v0.2: buttons that ask an agent (bound.json is the canonical list)
  "compare": { … }, "plan": { … }, "notes": [ … ], "votes": { … },
  "attribution": ["…"],
  "custom": "custom.js",                     // optional ES module (uw API)
  "css": "custom.css",                       // optional stylesheet, loaded after the engine's (restyle the chrome)
  "theme": "instafy"                         // chrome look: "instafy" (default) | "neutral" | { tokens } (see theme)
}
```

A config **without** `question` looks and behaves like v0, plus three fixes for every site: no dark band at the
horizon in steep 3D, note bubbles never cover pins, and the feel grid is smoothed with an on-map legend. With `question`, the map
becomes an answer: lettered option pins, a verdict strip in the sheet, why-cards, tiers and pin budgets.

## view

| Key | Default | Meaning |
|---|---|---|
| `center` | `[10, 25]` | `[lng, lat]` |
| `zoom` | `1.6` | With `bounds`: the zoom a phone needs for them; it caps the first view (phones +0.6, wide screens +1, so a tiny area never over-zooms). Without: the zoom. |
| `bounds` | none | `[[west, south], [east, north]]`: the area that must be visible. Every screen fits it, clear of the sheet / panel. |
| `pitch`, `bearing` | `0` | Degrees |

Don't type these: `uw fit <site>` writes them from the data (hand-picked points, routes and legs; walk areas when
there is one subject point; or `--layers a,b`). The ↺ button returns to this view. A shared URL (`#@=lng,lat,zoom`)
wins over it. A compass button appears when the map is turned; tap it for north-up.

## basemap

| Key | Default | Meaning |
|---|---|---|
| `style` | `"style.json"` | MapLibre style path or URL. The starter's is OpenFreeMap Liberty; edit it freely. |
| `labels` | `"en"` | `"en"`: English where OSM has it, else local. `"local"`. `"both"`: English + local on two lines. |
| `theme` | `"auto"` | `"auto"`: the map follows the time slider (day / dusk / night map). Without a time slider it follows the phone's dark mode. `"light"`, `"dark"`: fixed. Only the map changes: the sheet and buttons follow Studio's light / dark theme (else the phone's), never the slider. |
| `terrain` | `false` | `true`: the 3D button shows terrain + hillshade (AWS terrarium). Off: 3D only tilts. |
| `relief` | `false` | `true`: a soft hillshade also in 2D (mountains read at country zoom); implies `terrain`. Drawn under water. |
| `exaggeration` | `1.35` | Terrain height factor in 3D (0.5-3). |
| `overrides` | `[]` | Restyle basemap layers, applied after load (below). |
| `placeLabels` | `"auto"` | With a verdict areas layer the basemap's village / suburb / neighbourhood / quarter labels are hidden (the named areas say what a neighbourhood is like; automatic romanisations such as "Tsiancheng" only compete). `"all"` keeps them. |

**overrides[]**: `{ "layers": <selector>, … }` with any of:

- `layers`: a keyword, a regex on style layer ids, or a list of them. Keywords: `rail`/`railways`, `water`,
  `roads`, `buildings`, `parks`/`green`, `labels` (all symbol layers), `pois`, `boundaries`, `landuse`, `background`.
- `color`, `opacity`, `width`: shorthand, mapped to the right paint property per layer type (fill / line / text…).
- `paint`: `{ "line-color": "#22c55e", … }` raw MapLibre paint properties (ignored where they don't fit the type).
- `layout`: raw layout properties. `filter`: a MapLibre filter. `visible`: `false` hides, `true` shows.

The day/dusk/night look never overwrites a property an override set. Overrides only touch basemap layers, never
the site's own layers (style those with `layers[].style`).

```json
"overrides": [
  { "layers": "rail", "color": "#22c55e", "width": 2.5 },
  { "layers": "pois", "visible": false },
  { "layers": "^building", "opacity": 0.35 }
]
```

## time, vibe, air

| Key | Default | Meaning |
|---|---|---|
| `time.enabled` | `false` | Time-of-day slider in the header (0-24 h, half-hour steps). Night = before 06:00 or from 19:00. |
| `time.default` | `14` | Starting hour |
| `vibe.enabled` | on if a `grid` layer exists | Calm ↔ Lively dial; recolours the feel grid live |
| `vibe.default` | `0.5` | 0 = calm, 1 = lively |
| `vibe.grid` | first grid layer | Grid layer the dial drives |
| `air.enabled` | `true` when `data` is set | Air chip in the header ("PM2.5 12"), follows the time slider |
| `air.data` | none | `data/air.json` from `uw.mjs air` |

**Time windows only apply while the time slider is on.** With it on: a layer's `time`, a note's `time` and a
feature's `time_from`/`time_to` hide things outside their window (`[18, 26]` = 18:00 to 02:00). `places` writes
`time_from`/`time_to` from simple `opening_hours`, so places show only while open. Clusters still count hidden points.

**air.json** (written by `uw.mjs air`): `{ source, attribution, note, kind: "model", resolution_km, locations: [{ id, name,
lng, lat, by_hour: { "0": { pm2_5, pm10, … }, … "23": {…} }, current, summary, hourly }] }`. The chip shows the
PM2.5 average for the slider's hour (US EPA bands: Good ≤12, Moderate ≤35.4, Sensitive ≤55.4, Unhealthy ≤150.4).
With several locations it uses the selected feature's own entry (same `id`), else the nearest one. The file's
`attribution` and `disclaimer` (the CAMS licence text "Neither the European Commission nor ECMWF…") are added to the
map credits; the disclaimer also shows when the chip is tapped. Keep both.

## layers[]

Drawn in order: later layers sit on top. Ids: letters, digits, `-`, `_`. Ids starting `uw-` are reserved.

| Key | Default | Meaning |
|---|---|---|
| `id`, `type`, `data` | required | `type`: `points`, `lines`, `areas`, `grid`, `route`, `legs`, `heat`. `data`: path, URL, or an inline GeoJSON object. |
| `title` | the id | Shown in Layers, Places and cards |
| `group` | by type | Heading in the Layers tab (Places, Lines, Routes, Trip, Areas, Feel) |
| `visible` | `true` | Starts on or off; users toggle it in Layers |
| `style` | palette | See per type below |
| `label` | none | Text under points: a property (`"name"` = English name where present) or a template `"{name} · {price}"` |
| `list` | points: `true` if not clustered and ≤150 features | Show the features in the Places tab (searchable) |
| `selectable` | `true` (heat: `false`) | Tap opens a card |
| `card` | | `{ "subtitle": "{area}", "body": "{note}", "fields": ["cafes_10min", "nearest_mrt_m"] }`. Templates use feature properties. Default subtitle: local name · kind · area. Default body: `note` or `description`. `fields` are metric bars. |
| `cluster` | `false` | Points only: emoji + count bubbles that zoom in on tap (never more than 3 zoom levels per tap). Use for > 80 points. `{ "radius": 36, "maxZoom": 14 }` breaks clusters up sooner (defaults 46 / 15). |
| `linkedTo` | none | A points layer id. Features whose `for` equals the selected feature's id show strongly, others faint (walk areas per hotel). Selecting a point frames its linked area; its card gets a "10-min walk" button. |
| `linkedIdle` | auto | What linked areas do while nothing is selected: `"faint"` (default with several origins) or `"show"` (default with one origin, e.g. one station). |
| `time` | none | `[from, to]` hours: the layer shows only then (needs the time slider). The Layers tab shows this window itself, so don't repeat it in `note`. |
| `animate` | `true` | Route layers: `false` removes "Walk it" |
| `weight` | none | Heat only: numeric property used as weight |
| `minzoom`, `maxzoom` | | Zoom range. City-scale point sets (span < 0.25°) hide below z9.5 unless `minzoom` is set. |
| `legend` | none | One line of text under the layer's toggle |
| `note` | none | Replaces the layer's grey subtitle in the Layers tab (keep it short; one line) |
| `partial` | none | Written by `places` (a reason string) when its data is incomplete (a fallback provider of the places chain, `--limit` cut); removed by the next complete run. The Layers tab says "partial data"; enrich marks metrics made from it partial and the verdict shows a caveat chip. Don't set it by hand. |
| `attribution` | file's `attribution` | Credit shown while the layer is visible (HTML allowed) |
| `tier` | from `question` | `add-point` writes `"option"` for a new layer named like hotels/options/stays (until `uw question` runs these draw as plain pins), else `"support"`; `--tier` overrides. `places`, `feel`, `isochrone`, `areas`, `lines`, `wiki` and adapters register their layer with no tier: the question decides (not the answer = context). `"option"` (40 px lettered pins, never hidden), `"support"` (30 px badges, labels from z15.5), `"context"` (9 px dots; a badge from z16.5; hidden until a card mentions it). Without `question` every points layer is support. |
| `budget` | none | Max features of this layer shown inside its tier's shared budget (the rest stay in Places / search) |
| `rank` | none | Points: property used as priority (lower first) instead of distance to the nearest option |
| `role` | none | `"verdict"` on an areas layer from `uw areas` (named areas with verdict labels) |
| `expert` | auto | Grid: `true` = hidden "expert" layer with 3 classes (automatic when a verdict areas layer exists) |
| `lens` | none | Show this layer only under these lens ids (`["night"]`) |
| `links` | auto | `false` or a list such as `["google"]`: this layer's link-out row |
| `style.glow` | `false` | Points with time windows: a soft halo during the window (night markets "light up") |
| `labelZoom` | 13 / 15.5 | Support points: zoom from which their names show (13 for ≤ 12 places such as MRT stations, else 15.5) |
| `numbered` | auto | Legs: numbered stops in travel order with one dot per night (`nights` on the stop's points feature) and direction arrows. On for a `plan-route` question; `false` keeps plain stop circles. |

Points features with `n` (`"n": 2`) or a keycap emoji (`2️⃣`) are drawn as a numbered disc (a plain numeral, the same
on every platform).

### style per type

| type | keys (defaults) | notes |
|---|---|---|
| `points` | `color` (palette), `emoji`, `size` `s`/`m`/`l` or px (`m` = 32) | Badge = coloured circle + emoji. `style.emoji` wins over each feature's `emoji`; leave it out to use per-feature emoji (mixed kinds). A feature `color` wins over `style.color`. Selected = bigger + pulsing ring. Votes 👎 fade a point. |
| `lines` | `color`, `width` (3.5), `opacity` (1), `dash` (`true` or `[2, 1.5]`) | `"color": "{colour}"` = per-feature property (OSM line colours from `lines`), fixed colour as fallback. White casing for legibility. |
| `areas` | `color`, `opacity` (0.16), `outline` (`true`), `dash` | Fill + outline; the fill thins out at street zoom. |
| `grid` | none | The feel grid from `uw feel`. Grey → teal → green by the vibe score; tap a cell for the breakdown (labelled estimated). Water cells (`water: true`) are transparent; the two outer rings fade so the grid has no hard edge. |
| `route` | `color`, `width` (5), `dash` | Line + direction arrows (z13+). "Walk it" animates a walker along it (~6 s, camera follows; tap the map to stop); "Ride it" 🚲 for bike routes. |
| `legs` | `color`, `width` (3.5) | Each feature = one leg; curved arcs in trip order with a mode badge (`mode`: train, hsr, metro, bus, car, taxi, flight, ferry, walk, bike…; or `emoji`) and `duration` label. Flights dashed; a leg back over the same pair curves the other way. The card shows "≈ N km straight line"; a leg with `"track": true` (`uw legs --follow`) is drawn on its own coordinates and shows "N km by rail" (`track_km`). `duration_source_url` / `timetable_url` = a "Timetable ↗" button; `source_url` on any point = "Source ↗". |
| `heat` | none | Heatmap that fades into dots from z14.5 (dot colour: theme token `heat-pt`) |

Colour keywords for `lines`, `route` and `areas`: `"color": "walk"` = the theme's walk ink (`walk` by day,
`walk-night` at night; instafy: slate ink / warm grey), for walks and routes that are not an option's own;
`"color": "letter"` on a layer `linkedTo` the question's options = each feature (by its `for`, or a route's `from`) takes its option's
letter colour (A's walk area in A's colour), the rest the walk ink. Keep other layer colours away from the letter
colours and from the interaction blue: validate warns when a layer colour is within ~20 ΔE of a letter in use.

**Score formula** (grid): `night = h < 6 || h >= 19`; `s = (1-v)·calm_t + v·lively_t`; `score = 0.85·s + 0.15·green`.

### Feature properties the engine reads

`id` (unique in the file; scripts write `osm-n123` or a slug), `name`, `name_en`, `emoji`, `color`, `kind`, `area`,
`note`, `description`, `url`/`website` (Website button), `image` (https thumbnail on the card) with `image_credit`
(author · licence, shown under it) and `image_page`, `opening_hours`,
`time_from`/`time_to`, `for` (linkedTo / route link), `route` (id of a route layer to walk from this place),
`duration_min`, `distance_km`, `source` (card footer). Legs: `mode`, `emoji`, `duration`, `from_name`, `to_name`,
`duration_source`. Grid: `calm_day`, `calm_night`, `lively_day`, `lively_night`, `green`, `amenities` (0-1),
`n_cafe`, `n_food`, `n_gym`, `n_night`, `n_trees`.

Script-written files also carry top-level `"uw": { cmd, args, generated_at }` (who wrote it; protects it from
being overwritten by another command) and sometimes `"attribution"`. Leave both alone.

**Metric keys** written by `enrich`: `<layer>_<N>min` (inside the linked walk area), `<layer>_<N>m` (radius),
`nearest_<layer>_m` + `nearest_<layer>_name`, the feel scores above plus `noise_day_db`, `noise_night_db` (the block
at the door, `--feel`), the same averaged over the walk area as `calm_night_area`, `lively_night_area`, `green_area`…
(`--feel-within`), and `walk_min_<layer>` / `walk_km_<layer>` (street-network walking time, `--route-to`).
Labels and units are inferred (`nearest_mrt_m` → "To mrt", metres; `cafes_10min` → "Cafes ≤10 min"; `walk_min_mrt` → min).
Edit one feature's props by hand with `uw set <site> <layer>:<id> --props '{…}'` (no network).

## compare

```json
"compare": { "layer": "hotels", "max": 3, "metrics": [
  { "key": "cafes_10min", "label": "Cafés ≤10 min", "better": "higher" },
  { "key": "nearest_mrt_m", "label": "To MRT", "unit": "m", "better": "lower" },
  { "key": "calm_night", "label": "Calm at night (est.)", "format": "pct", "better": "higher" } ] }
```

Adds the Compare tab: pick up to `max` (1-5, default 3) features, one bar row per metric, ★ on the best (every
tied leader gets one), a 🏆 "leads on N of M" line (ties count for nobody). 👍-picked features are pre-selected. Metrics also appear as bars on that layer's cards.
`better`: `higher` | `lower` (colours the bars). `unit`: `m` (shows km over 1000), `min`, `km`, `dB`, or any text.
`format`: `pct` (0-1 → %), `int`, `km`, `min`, `db`. `"default": ["id1", "id2"]` chooses which features start in
the comparison (else 👍 picks, then layer order).

Compare metric keys added in v0.2: `threshold` (smaller differences are ties), `cap` (counts past it read "plenty"),
`scale` (shown under the label, e.g. "inside the 10-min walk"), `basis` (measured, routed, counted, estimated,
registry, filed, live), `always: true` (keep a row even when every option ties). With `question`, Compare shows the
options as lettered columns: Photo of the entrance, Legally registered, Price, then the criteria by weight (≤ 5 rows,
rows that tie on every option are hidden, the rest under "N more rows"). Each cell is a word or a number, no bar.

## question (v0.2)

Write it with `uw question` (it reads labels, units and anchors from `data/metrics.json`); edit by hand after.

```jsonc
"question": {
  "kind": "choose-one",               // choose-one | find-place | find-area | plan-route | explore
  "ask": "Which hotel for 3 quiet nights near the MRT?",   // ≤ 70 chars, the sheet heading
  "options": { "layer": "hotels", "ids": ["lore", "via-loft"], "letters": "given", "top": 5, "noun": "hotels" },
  "criteria": [
    { "key": "quiet_night_blocks", "weight": 3, "label": "Quiet streets within a 10-min walk",
      "phrase": { "lead": "quietest streets nearby", "value": "{value} quiet blocks nearby", "worst": "fewest quiet streets nearby ({value})", "zero": "no quiet streets nearby" } },
    { "key": "walk_min_mrt", "weight": 2, "phrase": { "lead": "closest MRT", "value": "MRT {value}" } },
    { "key": "noise_night_db", "weight": 1, "label": "Road noise at your door, night", "phrase": { "worst": "loudest door at night" } },
    { "key": "lively_night_blocks", "weight": 0 }        // weight 0: shown, may lead a verdict, does not rank
  ],
  "watch": [ { "key": "nearest_nightmarkets_m", "within": 400, "label": "Night market", "hours": "nearest_nightmarkets_hours", "lenses": ["sleep"] } ],
  "lenses": [ { "id": "sleep", "emoji": "🛏", "label": "Sleep", "persona": "Light sleepers", "time": 23, "vibe": 0.1,
                "weights": { "quiet_night_blocks": 3 }, "areas": ["quiet_night"], "show": ["areas"], "hide": ["markets"] } ],
  "lens": "sleep",                    // starting lens (night areas only show at night)
  "budget": { "option": 5, "support": 10, "context": 80 }
}
```

- `options.letters`: `"given"` (A = first of `ids`, else file order), `"rank"` (A = current #1) or `false`. `uw question`
  writes `ids` in rank order under the starting lens, so **A is the best match** and letters stay put when a viewer
  switches lenses (validate warns when the top option is not A). Letter colours come from the theme (instafy: A violet,
  B ochre, C crimson, D olive, E graphite: never the link blue or a teal; validate warns when two letters, or a layer and a letter, look alike; neutral: A blue, B orange, C violet, D teal, E pink; tokens
  `letter-a`…`letter-e`). They never mean good or bad. `options.noun` names them in "Top 5 of 445 <noun>" (find-place).
- `criteria[].key`: a numeric property on the options (or `claim:<attr>` from records). ≤ 6 criteria, ≤ 4 lenses. The peek says each lens's
  pick and why on that option's own line ("best for light sleepers: …"); with `"adjust": true` (only when the person asked to switch or tune) the lenses
  are also one segmented choice in words inside Adjust, under "Focus" (a lens `emoji` is not shown; keep `label` to one
  word). The peek keeps one row of tabs.
  Per-criterion overrides: `label`, `unit`, `better`, `basis`, `good`, `bad`, `threshold`, `cap`, `scale`, `source`.
- Ranking: goodness 0-1 per criterion, weighted mean, sorted strictly by score (the first verdict line is always the
  top score; only exact ties keep the given order). Goodness: estimated percentages (`calm_day`, `green`…) rank
  against this map's own feel grid (a percentile, so a dense city never saturates); other metrics use `good`/`bad`
  anchors (metrics.json or the criterion), else min-max. Two options within 0.03 are called "close" in the persona
  line, never reordered. `"adjust": true` shows "Adjust" (Focus, the time and the 3D / whole-map buttons); without it a
  question map has no Adjust and no 3D or whole-map button (pinch does both). `"adjust_weights": true` (implies
  `adjust`) adds the weight sliders and calm-to-lively (only when the person asked to tune the ranking; the hash keeps `w=`).
- Percentages are never shown bare: "top 5%" / "bottom 20%" of this map's blocks when a feel grid exists, else a word
  (very high … very low). A distance to an area's edge of 0 reads "inside" (or `phrase.zero`).
- `phrase`: `lead` (the option leads: "quietest streets nearby"), `value` ("{value} quiet blocks nearby"; `{label}`,
  `{n}` work too), `worst` (the option is the worst of them: "loudest door at night"), `zero`, `cross`.
- `watch`: facts about an option's surroundings that are not criteria (a night market 262 m away, 18:00-00:00). Within
  `within` m they get a ✗ why line with the distance, the hours and the basis, and they are the verdict caveat of the
  listed lenses ("… · but night market 262 m away (18:00–00:00)"; one "but" per line: after a "but" it is a plain fact). `uw question` adds one for a night-market layer.
- Kinds: `find-place` shows "Top 5 of N" (the rest become context dots, "Show all N" in Places); `find-area` answers
  with the verdict areas; `plan-route` numbers days/legs instead of letters; `explore` has no auto verdict.
- Visibility with a question: the options layer, criterion layers, the lens's `show`, linked walk areas, plan routes
  and option/support tiers start visible; everything else starts hidden ("Hidden to keep the map clear · tap to
  show" in the map key). An explicit `visible` always wins; an explicit `tier: "context"` stays hidden until mentioned.

## verdict (v0.2)

Default with a question: `{ "mode": "auto", "facts": 2, "persona": true }`. The engine writes one line per option
in rank order (`A Lore · quietest streets nearby est. · but night market 262 m away (18:00–00:00) 📏`). When lenses
with a `persona` disagree, each pick is said on its option's own line with its plain reason, in place of that line's
facts (`A Via Loft · best for light sleepers: quietest door at night, tied with C, and 4 quiet blocks nearby (C 0) ·
Estimate`): the heaviest weighted thing it is best at, saying a tie when there is one, and then the next thing that
sets it apart with the tied option's value. The line's caveat ("but night market …") stays. A decibel estimate is said
in words on the WHO night guideline (under 45 quiet, under 55 fairly quiet, under 62 some traffic noise, else loud
traffic), never as "65 dB". Each fact carries
its own basis tag (`est.` for estimates, 🧭 routed, 📏 measured, 🔢 counted, 🏛 registry/filed), so a routed minute is
never called an estimate. A line leads with what the option does best on what you weighted; the heaviest
criterion always says where the option stands, as a caveat ("but …") when it is the worst of them; weight-0 facts
only fill in after that. A caveat takes the second fact's place, so a line stays within two phone lines (lines wrap,
never "…"). find-place adds a heading "Top 5 of 445 independent cafés"; plan-route a summary "🚆 9 stops · 13 nights ·
10 rides by train & HSR · loop from Taipei" and `D1`, `D2` day lines (tap = that day, "+11 more days" = the plan);
find-area the plan's walk ("🚶 Relaxed coffee walk: 5 stops · 1.58 km · 21 min (routed)") and per area what it offers
beyond its own verdict. Lines cite the keys they use. Authored lines (`"mode": "authored"`, or `"pin": true` in auto mode) need `ref`, `text` and
`cites`; validate checks V1-V6 (cites present, every number equals a cited value, "est" for estimates, no banned
words, ref is an option). Never type numbers that are not in the data.

**Why-cards** come from the same criteria: up to 2 ✓ lines, 1 ✗ line (+ watched facts) and a trade-off sentence that
relates them ("Trade-off: quietest streets nearby, but loudest door at night (estimate), the worst of the 3"),
each with its value, the other options' values (`MRT 3 min (B 6 · C 9)`) and a basis chip. Labels name their scale
("Quiet streets within a 10-min walk" vs "Road noise at your door, night"); below 330 px the value moves under the
label. A feature `why` array (line objects with `cites`) is
shown first. Notes whose `at` is an option become editorial why lines instead of bubbles.

## Named areas (v0.2)

`uw areas` writes `data/areas.geojson`; add it as `{ "id": "areas", "type": "areas", "data": "data/areas.geojson",
"role": "verdict" }`. Each area has `verdict`, `name` (+ `name_local`), `why`, `basis`, `confidence`, `lens`,
`time_from`/`time_to`, `options` (cells of the drawn area inside each option's walk area: the `<lens>_blocks` numbers
can be counted on the map), `field` and `label_at`. Quiet lenses leave out cells next to a night market open in their
hours (`--avoid`, automatic with a night-market layer; validate rule A1 checks it). The engine draws soft fills by lens
(quiet teal, lively pink, green green), a two-line label (hidden while it would run off the screen or under the
buttons), and only the active lens's areas. Tap = area
card with "Show the evidence" (turns on the expert grid). The grid becomes an expert layer: hidden, 3 classes,
3×3 smoothing, faded outside the walk areas, a one-line legend pill on the map.

## links (v0.2)

Option and support cards get a row of link-out chips (≥ 44 px, open in a new tab, nothing embedded):
`streetview` (Street View ↗ facing the door when `uw doorstep` wrote `sv_viewpoint` + `sv_heading`), `google`,
`apple`, `lookaround` (Apple devices, or `"lookaround": true`), `directions`, `panoramax` (the photo's page).
Context cards get `google` only. On by default for version 2; v0 configs keep "Open in Maps".

```jsonc
"links": { "show": ["streetview", "google", "directions", "lookaround"], "layers": ["hotels"],
           "directions": { "label": "To Taipei Main ↗", "from": { "layer": "sights", "id": "taipei-main" }, "mode": "transit" } }
```

Checked in emulated phone Chrome (11 Oct 2026, not yet on real iOS/Android): the Apple `?q=&ll=` and `look-around`
forms open the right place (look-around keeps the heading); the Panoramax `#focus=pic&pic=<id>` link opens the photo;
the Google forms land on Google's EU cookie-consent page first (the target is kept), so what opens after consent is
unconfirmed. Feature props used: `name`, `address`, `area`, `place_id`, `entrance`, `sv_viewpoint`, `sv_heading`.

## photos (v0.2)

`"photos": { "layers": ["hotels"] }` (also `"data": "data/photos.json"`, `"viewer": "builtin" | "pannellum" | "link"`).
`uw photos` writes the file. Cards show a dated 16:9 doorstep thumbnail (`Jul 2026 · 25 m · ◐ 360°`) with the
author credit always visible, or one row "📷 No street photo within 40 m (nearest 106 m) · Street View ↗". `uw photos`
leaves out pictures taken from a bridge or expressway next to the door's street (the card says so). Tapping opens a full-screen viewer
(360° photos: drag, pinch, "Look at the door"; Esc / back closes). Compare gets a "Photo of the entrance" row. Never replace a
missing photo with a farther one.

## Records, licence chip and checked facts (v0.2)

Results from adapters and agents are **records** (`data/records/<name>.json`, schema `uw.records@1`): `claim`
(a fact about a feature: `ref`, `attr`, `value`, `basis`, `prov`), `offer` (a price with seller and variant) and
`item` (a new place). Every record has `prov` (source, lane, observed_at, ttl_s, as_of, url, intent). The engine
validates them, shows strings as text only, merges by id (newer `observed_at` wins) and adds ↻ "check again" when an
intent can refresh them. Freshness: live data (`class: "live"`, offers) expires on `ttl_s` / `expires_at`; stored
official data (`class: "stored"`) never "expires" on a TTL: rows say "data as of 9 Sep 2026 · checked 15:04" and
"may be out of date" after `prov.refresh_days` (default 45). A records file larger than 200 KB is read partially
(newest first); `uw host` keeps its files under 180 KB by dropping the oldest results (an item with its claims).
`data/version.json` (`{ v, files, jobs }`) tells viewers what changed; `jobs[id]` is `{ state, name, ref, error,
summary }`, so every viewer (and a late joiner) sees running jobs and the last error per item.

- `licence` (claim or feature property from `uw adapter tw-hotels`): chip in the card head
  `✓ Registered hotel · 臺北市旅館166號`, `ⓘ Possibly … · match medium`, or `ⓘ Not found in register (checked …)`.
  Never "illegal"/"unlicensed". One claim per register: when they disagree the chip says "sources differ" and the
  sheet shows each register's answer (and the holder name each uses, "Registered as 院院樂居"); none is picked.
  Compare gets a "Legally registered" row with each cell's own register. Tap = source sheet.
- Other claims: "Checked facts" rows `Filed max rate NT$15,000 · Taipei hotel register · 9 Sep 2026` + basis chip.
- Offers: a Prices block, a price pill under option pins, a Price row in Compare. "Best price" only among offers that
  compare like with like (currency, price kind, dates/guests, refundability, taxes known); an offer with unknown
  taxes is "Lowest seen (taxes unclear)", never best. Instafy's `travel.offer@1` records are mapped to offers.
- Items: features in `item.layer` (created from the intent's `target.create` when missing), footer "Found by …".

## bound.json and intents (v0.2)

`bound.json` at the site root declares the buttons that ask an agent to do something; add `"bind": true` to the
config so every host loads it (`uw host` loads it anyway). `map.config.json` `"intents"` takes the same shape for
UI-only intents. `"bind": { "parentOrigins": ["https://instafy.dev"], "results": { "poll_s": 3 } }` tunes it.

```jsonc
{ "version": 1,
  "intents": { "check_registry": {
      "label": "Check licence", "emoji": "🪪", "describe": "Look this hotel up in Taiwan's hotel registers",
      "params": { "type": "object", "required": ["ref"], "additionalProperties": false,
                  "properties": { "ref": { "type": "string", "maxLength": 120 }, "name": { "type": "string" },
                                  "lnglat": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
                                  "refresh": { "type": "boolean" } } },
      "prefill": { "ref": "$item.ref", "name": "$item.name", "lnglat": "$item.lnglat" },
      "ui": ["card", "compare-cell:licence"], "layers": ["hotels"],
      "target": { "records": "data/records/check_registry.json", "layer": "hotels" },
      "pending": "item", "confirm": false, "cooldown_s": 20, "timeout_s": 90,
      "sources": ["data.gov.tw/7780", "data.taipei/135464"], "handler": "pack:check_registry" } },
  "results": { "files": ["data/records/check_registry.json"], "poll_s": 3, "sse": true } }
```

- `params`: a JSON-Schema subset (type, properties, required, additionalProperties false, enum, const, default,
  minimum/maximum, min/maxLength, pattern, items, min/maxItems, format date/date-time/uri, title, description).
  Missing required params open a small form; ≤ 4 KB.
- `prefill` tokens (`|` = first defined): `$item.ref|id|layer|name|lnglat|<prop>`, `$pin.lnglat`, `$view.center|bbox|zoom`,
  `$state.hour|lens|weights`, `$options.refs`.
- `ui`: `card` (card actions), `card-more` (⋯ and long-press on the card head), `sheet-header` (chip after the
  lenses), `map-context` (long-press pin card), `compare-cell:<attr>` (↻ on that Compare cell / fact row), `list-row`.
- `pending`: `item` (pin dots + skeleton rows), `layer` (spinner + a progress line with Cancel), `cell:<attr>`, `none`.
- `produces`: the claim attributes the intent writes (`["licence", "registered_rooms"]`): all of them show as pending
  while it runs, and each fact row gets ↻. `doneLabel` / `againLabel`: the button after a job ("✓ Checked · now",
  then "Check again" once `cooldown_s` is over). The card's first `card` intent sits in the card head, by the licence chip.
- `layers` may name a layer another intent creates (`target.create`), e.g. "Check licence" on hotels found nearby.
- A `layer` job (`find_hotels_nearby`) ends with its results framed and never hidden by the pin budget, the search
  radius drawn, and its summary as a dismissable chip ("✓ 11 registered hotels within 600 m · …", also "nothing found").
- `handler` (for `uw host`): `pack:check_registry`, `pack:find_hotels_nearby`, or a site file `handlers/<name>.mjs`.
- Buttons appear only when a listener answers (Instafy's `hello`, a MessagePort, `window.instafy`, or `uw host`);
  `#bind=1` forces them for tests. Out: one `{source:"instafy-map", v:2, type:"intent", id, name, params, ref, ui,
  state, at}` message over postMessage, the `uw:intent` window event and `POST __uw/intent`. The page never says who
  clicked (hosts stamp that). In: host messages (`hello`, `ack`, `progress`, `results`, `done`, `error`, `command`) over
  postMessage, SSE `__uw/events`, or by polling `data/version.json`. Hosts dedupe by `id`; every viewer gets every result,
  and sees other viewers' jobs as pending ("Someone else: Checking the register…").
- **Instafy bind v1** (Instafy `docs/Bound-Sites.md` §2): on a host that speaks `{source:"instafy-bind", v:1}` (a MessagePort from the
  Studio pane, `window.instafy`, or the parent) the page sends `hello {siteId, manifestHash: sha256 of bound.json}`,
  `intent.request {iid, name, params}`, `intent.cancel`, `intent.resume {from}` after a reload and `session.show {iid,
  taskId}` ("Show" when a task needs the person: sign in, a check). It reads `hello.ack`, `intent.accepted` (with its
  per-source plan: "agoda.com: extracting · booking.com: queued"), `intent.rejected`, `task.status`, `task.needs_user`,
  `record.upsert` (uw records or `travel.offer@1`), `record.expire`, `intent.done` (counts: "1 of 2 sources answered (1
  blocked)"), `browser.location` (pulses the matching pin) and `data.version`. UI events stay on the parent frame.
- Cooldowns are per item, or for map searches per spot (~50 m): the page and `uw host` compute the same key, and a
  refused repeat is a 202 `{status:"rejected", retry_after_s}`, never a 429. "Check again" re-matches against the
  cached dataset; it does not download it again.
- A host that said `hello` may hold an intent in a confirm tray: the button then says "sent to chat, waiting" (no
  "No agent" toast), and time spent waiting for a person does not count against `timeout_s`.

## plan

```json
"plan": { "title": "Plan", "days": [
  { "title": "Day 1 · Taipei: arrive", "date": "2026-10-24", "text": "Check in, coffee walk.", "time": 15,
    "focus": { "layer": "hotels", "id": "regent" }, "route": "day1",
    "items": [ { "text": "Coffee", "ref": { "layer": "cafes", "id": "osm-n123" }, "time": 16 },
               { "text": "Dihua Street", "ref": { "layer": "sights", "id": "dihua" },
                 "url": "https://en.wikipedia.org/wiki/Dihua_Street", "source": "Wikipedia" } ] } ] }
```

An item's `text` is its name; `note` (≤ 120 characters) is one line under it ("ask about trail status"), as on the
timeline page. An item's `time` sets the map's hour when the day opens; it is not shown as a clock column.
An item's `url` (https only) is the page its facts came from: shown as "Wikipedia ↗" (`source`, ≤ 40 characters, else
the host name) under the item. An item's `check` (≤ 80 characters) is what is not checked about it, said as on the
pages: "Not checked · which trails are open · where to check ↗" (`check_url`, https). A trip's plan is written by
`uw plan` (dates, nights, legs, stays, sights; see itinerary.md); add one short `text` per day by hand.
`"depart": true` marks the day after the last night (`uw plan` writes it): nothing is planned on it, its row says
"Departure", and the page's "N days" does not count it. A day's places should lie together: `uw validate` warns when
one is far from the day's other places or nearer another day's (thresholds: `scripts/plan-checks.json`).

Adds the Plan tab: one list of every day, the same day rows as Instafy's timeline page ("Sat 24 Oct · Taipei": the
title before `: ` without a trailing "(…)"; the caption counts its items and what is not checked: "4 stops · 2 not
checked"), the current day open under its row; a tap on another day's row opens it (one way through the days).
`date` (optional, YYYY-MM-DD) puts the weekday and date first; a title that already
starts with one ("Sat 24 Oct · Taipei", as `uw plan` writes) keeps it. The sheet's peek shows the plan summary, not
the days. Opening a day sets the time (Adjust shows it),
selects `focus`, shows its `route` layer (route layers named in any day show only on their day) and frames
everything. Items with a `ref` are tappable (legs too). "Walk it" walks the day's route feature that starts at (or
is `for`) the `focus`, so one route layer can hold one route per hotel. A `#d=3` link opens the Plan tab on day 3.

## notes, votes, attribution, custom

- `notes[]`: `{ "at": { "layer": "hotels", "id": "regent" } | [lng, lat], "emoji": "🌙", "text": "Quiet after 22:00 (est.)", "time": [21, 24] }`.
  Small speech bubbles (2 lines, ~50 characters; tap to read the rest); hidden below z13.5. They flip to the
  left near the button column and shrink to their emoji when they would collide. `at` coordinates must come from a script.
- `missing[]`: `{ "name": "Lore Hotel", "layer": "hotels", "tried": ["OpenStreetMap search (Photon)", "Taiwan lodging registers (…)"] }`.
  Places the user asked for that are not on the map yet: one "Not found yet: …" line in the sheet header (tap for
  what was searched). `add-point` adds an entry on a refusal and removes it once the place is added; validate warns
  while any remain (ask the user for their addresses). Optional `hint` replaces "Send its street address to add it."
- `votes`: `{ "<featureId>": { "up": ["Kim"], "down": [] } }`: chips on cards and list rows (write them from chat).
  Each viewer's own 👍/👎 is kept in their browser and merged in.
- `attribution`: extra credit strings (HTML allowed), shown in the map credits and the Layers tab.
- `custom`: path of an ES module whose default export receives the `uw` API (below). Errors show a toast, the map keeps working.
  It runs before a shared link's selection is applied, so cards show what it adds.
- `css`: path of a stylesheet loaded after `engine.css` (chrome tweaks; `.uw-…` classes).

## theme

The chrome's look (sheet, side panel, buttons, chips, tabs, cards, toasts, verdict strip, compare) and the colours
the engine draws itself (letter pins, default layer colours, the walk trail, the basemap at night). It does not touch
your layer colours or `style.json`; `basemap.theme` still decides day / night for the map.

- `"instafy"` (default, also when the key is missing): the same look as Instafy's plain pages (the
  `instafy bind init --starter …` pages share these colours, corners and dark mode). Paper white and ink, warm slate
  greys, blue `#0066AC` (dark `#2D7CD7`) only for the one filled button, links and focus; the chosen tab or lens is a
  neutral fill with a check, not blue; 8 px buttons (never pills), 12 px inputs and boxes, 16 px panels; "est." and
  sources are quiet grey captions; charcoal dark mode and a charcoal night map.
- `"neutral"`: the engine's look before themes (indigo accent, navy night). Use it to keep an older site exactly as it was.
- An object: `{ "base": "neutral", "accent": "#e11d48", "accent-fill": "#e11d48", "radius-btn": "12px",
  "dark": { "accent": "#fb7185" } }`. `base` picks the preset to start from (default `instafy`); other keys are tokens
  (`"accent"` = `--uw-accent`) that apply in every look; `"light": { … }` applies in light mode only, `"dark": { … }`
  in dark mode only. Dark mode is Studio's theme when the map is open in Studio, else the phone's setting; the time
  slider's night map does not switch the panels. Values are one CSS value each (validate rejects `; { } < >`).

Main tokens (all `--uw-*`; engine.css lists every one with both presets' values):

| token | what |
| --- | --- |
| `bg`, `bg-solid`, `card`, `map-bg`, `panel-border` | sheet / panel surface, solid surface, buttons on the map, page behind the map, panel edge |
| `fg`, `fg2`, `muted`, `line`, `line2`, `chip`, `press` | text, body text on buttons and badges, secondary text, dividers, subtle fills, pressed rows |
| `accent`, `accent-fill`, `on-accent`, `accent-hover`, `accent-soft`, `accent-ink`, `link`, `focus`, `focus-input` | `accent`: switches, checkboxes, the ripple; `accent-fill`: the filled button and its text (`on-accent`); text links; the focus ring and the input focus ring |
| `btn-bg`, `btn-fg`, `btn-ring`, `sel-bg`, `sel-fg`, `sel-ring` | secondary buttons; the selected lens, toggled button and best compare cell |
| `tab-on-bg`, `tab-on-fg`, `tab-on-shadow`, `tabs-fill`, `tab-bar`, `tab-radius`, `tab-inset` | the tab group (instafy: a segmented control, the selected tab raised; neutral: an underline) |
| `check`, `cross`, `good`, `est-bg`, `est-fg`, `up-*`, `down-*`, `stale` | ✓ / ✗ marks, best value, "est." basis (neutral preset), vote chips |
| `letter-a` … `letter-e`, `cat-1` … `cat-6`, `palette`, `walk`, `walk-night`, `me` | option letters, Adjust criteria colours, default layer colours, walk ink ("Walk it" trail, `"color": "walk"`) by day / at night, your location |
| `area-quiet`, `area-lively`, `area-green`, `area-amenities` (+ `-day` / `-night` variants of quiet / lively), `heat-pt` | named-area fills by lens, heat dots |
| `time-ramp`, `vibe`, `vibe-ramp`, `score` | time slider gradient, calm ↔ lively colours |
| `night-bg`, `night-land`, `night-water`, … `night-sky`, `day-sky`, `dusk`, `dusk-water`, `night-water-mix` | the basemap at night / dusk (`night-water-mix` 0-1: how far water moves to `night-water`; instafy 0.98) |
| `radius-sheet`, `radius-panel`, `radius-box`, `radius-btn`, `radius-input` | corner radii |
| `shadow`, `shadow-sheet`, `shadow-fab`, `shadow-thumb`, `toast-bg`, `toast-fg`, `overlay`, `scrim`, `font` | elevation, toasts, dialog scrim, photo captions, font stack |

Keep semantic colours distinct (letters, ✓ / ✗, basis chips, the time ramp) and text at WCAG AA contrast (4.5:1) on
both the light and dark surfaces. Where an override goes (the presets use zero-specificity selectors, so any site
rule wins over them):

- Chrome tokens (surfaces, text, accent, chips, tabs, toasts): `"theme"` keys (above), or a site's `"css"` file on
  `.uw-root { --uw-accent: … }`. For dark mode use the presets' two selectors, so Studio's theme wins over the phone's:
  `@media (prefers-color-scheme: dark) { html:not([data-uw-host-theme="light"]) .uw-root { … } }` and
  `html[data-uw-host-theme="dark"] .uw-root { … }`. Restyle only when the person asks; the default matches their
  other Instafy pages.
- Drawn tokens (`letter-*`, `cat-*`, `palette`, `walk`, `walk-night`, `area-*`, `heat-pt`, `night-*`, `dusk*`,
  `day-sky`): the engine reads them once from `<html>` at load, before the `"css"` file arrives. Set them as top-level
  keys of `"theme"` (validate warns when they sit inside `light` / `dark`, which the engine would read only in the
  mode the page opened in), or in `:root { … }` in index.html's own `<style>`.

`<html data-uw-theme="neutral">` in index.html works too when the config has no `theme`.

## Runtime: URL, API, events

**URL hash** (kept live, shareable): `t` hour, `v` vibe, `s=layer:id` selection, `p=lng,lat` dropped pin,
`off=`/`on=` layers toggled from their default, `d` plan day (1-based), `@=lng,lat,zoom[,bearing,pitch]` camera,
`l` lens, `w=key:3,key:1` user weights, `bind=1` force intent buttons (tests).

**`uw` API** (custom.js and `window.uw`): `map` (MapLibre), `config`, `state`, `on(evt, fn)` (returns an unsubscribe),
`off`, `emit`, `select(layer, id, { fly, card })`, `clearSelection()`, `flyTo(target)` (`[lng,lat]`, bbox, or
`{layer,id}`), `setTime(h)`, `setVibe(v)`, `setDay(i)`, `setLayerVisible(id, bool)`, `set3d(bool)`, `walk(layer, id)`,
`dropPin([lng,lat])`, `addLayer(def)` (same shape as a config layer; `data` may be an object), `getFeatures(layer)`,
`getLayer(layer)`, `random(layer)`, `setFilter(layer, fn | null)` (show only features where `fn(feature)` is true;
updates map, Places, Compare and cards), `refresh()` (re-render panels after you changed feature properties),
`ui.toast(text, ms)` (a leading emoji is dropped), `ui.addButton({ id, label, title, onClick, adjust })` (`adjust: "Fly
the loop"`: on a question map the button lives in Adjust under that word, not on the map),
`ui.openSheet('places'|'plan'|'layers'|'compare'|'card')`, `ui.snap('peek'|'half'|'full')`, `util`.
v0.2: `question` (resolved), `rank()` → `[{ref, letter, score, g}]`, `setLens(id|null)`, `setWeights({key: w})`,
`intent(name, params, {ref, ui})` (throws for undeclared names; resolves to the intent id), `ingest(hostMessage)`,
`records(ref?)`, `pending()` (this viewer's and other viewers' jobs), `links(layer, id)`, `signal()` (the clutter
report `snapshot --signal` reads), `registerLayer(mapLayerId, 'option'|'support'|'context')` (a layer custom.js drew
itself counts in `signal()` like the engine's own tiers), `locate({ watch, onFix(pos, info), onError(kind, { message }) })`
→ an id or null (moves the "me" dot; the first fix flies there; inside a host whose layout says `caps.location: "host"`,
such as Instafy Studio, it asks the host, else the browser) and `stopLocating(id)`. The position only reaches these
callbacks: never put it in an intent or event (the person sees in Studio which sites got it, not where it went). Toasts sit just above the sheet on phones and go away at
the first touch on the map.

**Events**: `ready {title}`, `select {layer,id,name,feature}`, `clear`, `pick`/`nope {layer,id,name,on}`,
`pin {lngLat,name,cell,score}`, `time {hour,label}`, `vibe {vibe,label}`, `layer {layer,id,name,visible}`,
`day {index,day,title}`, `3d {on}`, `look {look}` (`day`/`dusk`/`night`; also `uw.state.look`); v0.2: `lens {id}`,
`weights {weights}`, `intent {id,name,params,ref,ui}`, `ack {id,status}`, `results {id,count,refs}`, `done {id, summary}`,
`error {id,code}`, `link {layer,id,kind,url}`, `photo {layer,id,photo_id,action}`, `verdict {lines}`. Each is also sent as a `uw:event` window event and, inside an iframe, as
`parent.postMessage({ source: 'instafy-map', v: 1, type, payload, title }, '*')` (without `feature`).

`window.__uwReady` turns `true` once the map is idle with all layers; `window.__uwErrors` lists problems.

## Layout rules (for custom.js)

Engine-made MapLibre ids: a layer `hotels` becomes `uw-hotels` (+ `-casing`, `-cluster`, `-fill`, `-line`,
`-arrows`, `-badges`, `-stops`, `-pts`). Ids starting `uw--` are engine internals. Phones get a bottom sheet
(peek / half / full; peek shows the header, sliders and tab bar); screens ≥ 900 px wide and landscape phones get
a left panel (380 px; 300 px on short landscape phones). Custom buttons join the right-edge column (44 px, emoji or
short text labels). The camera keeps the map's own padding at 0: never pass `padding` to camera calls; `uw.flyTo`
centres targets in the visible part of the map itself.
