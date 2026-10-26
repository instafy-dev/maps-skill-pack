# Map pack v0.2: engine spec addendum (build contract)

*11 Oct 2026. This is an addendum to `ENGINE-SPEC.md` (v0). Everything there still holds unless a section below replaces
it. Two builders work from this file in parallel: **engine** (`starter/engine/*`) and **scripts**
(`scripts/uw.mjs`, `scripts/lib/*`, `scripts/adapters/*`, `handlers/*`, `schemas/*`). Each section ends with an
**Owner** line. Data-source terms: `DATA-SOURCES.md`. `examples/` is not part of this repository.*

v0.2 has two goals:

1. **A good boilerplate map.** It answers the question at a glance, shows little noise and feels like a place:
   - lettered options;
   - a verdict strip;
   - named areas;
   - why-cards;
   - doorstep photos;
   - link-outs.
2. **Ready for two-way binding to an AI agent.** Buttons emit typed intents. Results stream back as records with
   provenance and render live for everyone viewing. The map side does not depend on any one transport. The Instafy
   side is designed elsewhere.

---

## 0. Ground rules

### 0.1 Compatibility

- **v0 sites must still render unchanged.** A config without `question` behaves exactly as in v0, except for the
  fixes in §12, which apply to everyone. All new keys are optional.
- `version` may be `1` or `2`. `validate` recommends `2` once a site uses `question`, `bound.json` or records. The
  engine treats the two the same way. The number tells readers which spec applies.
- New top-level config keys: `question`, `verdict`, `links`, `photos`, `bind`, `signal`. Add them to `TOP_KEYS` in
  both `engine.js` and `cmd-validate.mjs`.
- New layer keys: `tier`, `rank`, `budget`, `role`, `lens`, `expert`, `links`, `glow`. Add them to `LAYER_KEYS`.
- New compare-metric keys: `threshold`, `cap`, `scale`, `basis`, `always`.
- Bridge events keep `v: 1` and the same shape. Only the new `intent` message uses `v: 2` (§9.3).
- `uw upgrade` copies the v0.2 engine into v0 sites. Those sites must pass `validate` with zero new errors. New rules
  that would fire on a v0 site are warnings unless `--signal` or `--strict` is given.

### 0.2 New files

```
starter/engine/
  question.js        ranking, goodness, verdict + why generation, lenses, weights          (engine)
  bind.js            intents out (4 transports), results in (3 transports), pending state    (engine)
  records.js         record merge, TTL, freshness, sanitising                              (engine)
  links.js           link-out URL builders                                                  (engine)
  photos.js          card thumbnail, Compare doorstep row, lazy 360 viewer                  (engine)
  signal.js          uw.signal(): in-page clutter report used by `snapshot --signal`        (engine)
  vendor/pannellum/  pannellum.js, pannellum.css, LICENSE (MIT, v2.5.6, loaded lazily)      (scripts vendors, engine loads)
scripts/lib/
  cmd-areas.mjs  cmd-doorstep.mjs  cmd-photos.mjs  cmd-adapter.mjs  cmd-host.mjs  cmd-question.mjs
  metrics.mjs        read/merge data/metrics.json
  records.mjs        record schema check + normalise + merge (shared by host, validate, adapters)
  schema-lite.mjs    the JSON-Schema subset validator (§9.2), shared with the engine's copy
  geo.mjs            point-on-segment, bearing, polygon union of grid cells, chaikin, polylabel
  zip.mjs            minimal zip reader (central directory + zlib.inflateRawSync), for data.gov.tw zips
scripts/adapters/
  tw-hotels.mjs  tw-night-markets.mjs  lib/twnorm.mjs (zh normalisation)  lib/match.mjs
handlers/
  check_registry.mjs  find_hotels_nearby.mjs
schemas/
  records.schema.json  bound.schema.json  messages.schema.json
```

Pack limits still apply: 256 files and 8 MiB per skill. Pannellum adds about 70 KB.

### 0.3 Shared vocabulary

- **Basis** (the enum used everywhere: metrics, why-lines, claims and chips):

  | basis | Meaning | Default confidence | Chip |
  |---|---|---|---|
  | `measured` | an instrument or a count of real observations | high | 📏 measured |
  | `routed` | street-network routing (OSRM/Valhalla) | high | 🧭 routed |
  | `counted` | count of mapped objects (OSM). Completeness varies | medium | 🔢 counted |
  | `estimated` | our model (feel grid, noise, areas) | low | ≈ est. |
  | `registry` | an official register or open dataset | high | 🏛 registry |
  | `filed` | a value filed with an authority (e.g. a filed max room rate) | high | 🏛 filed |
  | `live` | an API value at a time, with a TTL | high until TTL | ⏱ live |
  | `brand` | the seller's or maker's own claim | medium | 🏷 brand |
  | `user_note` | text a person typed | — | ✍ note |
  | `editorial` | the agent's own wording, with no number | — | (no chip) |

  The older basis words `modelled` and `inferred` map to `estimated`. The engine accepts both spellings and shows `estimated`.
- **Confidence**: `high` | `medium` | `low`.
- **Ref**: `"<layerId>:<featureId>"`, the same as the URL-hash `s=` form.

### 0.4 `data/metrics.json`: the metric registry (new; written by scripts, read by engine and validate)

Every command that writes a metric onto features also writes or merges its description here. The engine uses the
file for labels, units, basis and anchors instead of guessing from the key name. `metricMeta()` falls back to v0
guessing when the file or a key is missing.

```jsonc
{
  "uw": { "cmd": "metrics", "updated_at": "2026-10-11T14:00:00Z" },
  "metrics": {
    "walk_min_mrt": {
      "label": "Walk to MRT", "short": "MRT", "unit": "min", "format": "int", "better": "lower",
      "basis": "routed", "confidence": "high",
      "source": "OSRM foot (FOSSGIS) on OpenStreetMap", "scale": "door → nearest station",
      "layer": "mrt",                 // the context layer this metric is about (for "mention" reveals, §3.5)
      "id_key": "walk_id_mrt",        // property holding the id of the feature it measured to (optional)
      "good": 3, "bad": 15,           // anchors for goodness (§1.4); optional
      "threshold": 2,                 // a smaller difference counts as a tie
      "as_of": "2026-10-11", "cmd": "enrich"
    },
    "quiet_night_blocks": {
      "label": "Quiet blocks at night", "unit": "blocks", "better": "higher", "basis": "estimated",
      "source": "uw feel + uw areas (OpenStreetMap)", "scale": "inside the 10-min walk",
      "good": 10, "bad": 0, "threshold": 3, "layer": "areas", "cmd": "areas"
    }
  }
}
```

**Scripts duties:**
- `enrich` writes an entry per key it writes, plus `nearest_<layer>_id` and `walk_id_<layer>` properties next to the
  existing `nearest_<layer>_name`.
- `areas`, `doorstep`, `photos` and the adapters write their own entries.
- The `metrics` file is merged by key and never overwritten wholesale.

**Owner:** scripts write; engine reads.

---

## 1. The `question` block

### 1.1 Shape

```jsonc
"question": {
  "kind": "choose-one",                      // choose-one | find-area | plan-route | find-place | explore
  "ask": "Which hotel for 3 quiet nights near the MRT?",   // ≤ 70 chars; shown as the sheet heading
  "options": {
    "layer": "hotels",                       // the layer whose features are the answer candidates
    "ids": ["lore", "via-loft", "everstar"], // optional: subset + letter order; default all features in file order
    "letters": "given",                      // "given" (ids order) | "rank" (A = current #1) | false (no letters)
    "top": 5                                 // find-place: how many ranked features are options; rest → context
  },
  "criteria": [
    { "key": "quiet_night_blocks", "weight": 3, "label": "Quiet at night",
      "phrase": { "lead": "quietest nights", "value": "{value} quiet blocks" } },
    { "key": "walk_min_mrt", "weight": 2, "label": "MRT walk",
      "phrase": { "lead": "closest MRT", "value": "MRT {value}" } },
    { "key": "green", "weight": 1, "label": "Green doorstep",
      "phrase": { "lead": "greenest doorstep" } },
    { "key": "lively_night_blocks", "weight": 0, "label": "Night buzz",
      "phrase": { "lead": "liveliest nights" } }
    // any other metric keys from data/metrics.json: unit, better, basis, good, bad, threshold, cap, scale, source
    // may be overridden per criterion
  ],
  "lenses": [
    { "id": "sleep", "emoji": "🛏", "label": "Sleep", "persona": "Light sleepers",
      "time": 23, "vibe": 0.1, "weights": { "quiet_night_blocks": 3, "walk_min_mrt": 1 },
      "areas": ["quiet_night"], "show": ["areas"], "hide": ["markets"] },
    { "id": "night", "emoji": "🍜", "label": "Eat tonight", "persona": "Night owls",
      "time": 20, "vibe": 0.85, "weights": { "lively_night_blocks": 3, "walk_min_mrt": 1 },
      "areas": ["lively_night"], "show": ["markets", "nightmarkets"] },
    { "id": "move", "emoji": "🚇", "label": "Get around", "time": 9,
      "weights": { "walk_min_mrt": 3 }, "show": ["mrt", "metro", "mrtwalk"] }
  ],
  "lens": "sleep",                            // starting lens (optional; none = base weights)
  "budget": { "option": 5, "support": 10, "context": 80 }
}
```

Rules:
- `criteria[].key` must be a numeric property on every option feature, or a record attribute (`claim:<attr>`, §9.6).
  A missing value on one option is allowed. It shows "—" and counts as goodness 0.5 with confidence `low`.
- `weight` ≥ 0. Weight 0 means the criterion is shown and may lead a verdict, but it does not rank.
- At most 6 criteria and at most 4 lenses. More is a validate error: choosing needs few dimensions.
- `phrase.lead` is used when the option is the sole leader. `phrase.value` is a template with `{value}` formatted
  (unit included) and `{label}`. Defaults: lead = `"best " + label.toLowerCase()`, value = `"{label} {value}"`.

### 1.2 Kinds and the defaults they drive

| kind | Options are | Ranking | Verdict strip (auto) | Default tab | Other defaults |
|---|---|---|---|---|---|
| `choose-one` | features of `options.layer` (2-5) | weighted goodness | one line per option, in rank order, + persona line | Compare (when ≥ 2) | lettered pins; the grid becomes an expert layer if an areas layer with verdicts exists |
| `find-area` | features of an `areas` layer with `verdict` (§6) | weighted goodness over area metrics | top 3 areas: `"<verdict> · <name> · <fact>"` | Places | grid is expert; options get no letters, the areas are labelled on the map instead |
| `plan-route` | `plan.days` (or a `legs` layer) | none (order is the answer) | one line per day/leg, ≤ 4: `"1 · <title> · <duration>"` | Plan | numbered stops (1, 2, 3…) instead of letters; leg badges only at z ≥ 8 |
| `find-place` | top `options.top` features of `options.layer` by score | weighted goodness | `"Top 5 of N · <#1 name> · <fact>"` | Places | the other features become the context tier (dots); the list shows "Top 5 · show all N" |
| `explore` | none | none | only when authored (`verdict.lines`) | Places | tiers and budgets still apply; clusters stay allowed |

**Visibility defaults** apply only when `question` exists and a layer has no explicit `visible`:
- Visible: the options layer; layers named by a criterion's metric `layer`; the active lens's `show`; areas linked to
  options (`linkedTo`); route layers named in `plan`; any layer with `tier: "option"` or `"support"`.
- Hidden but listed in Layers: everything else, i.e. context layers (§3.5). The Layers tab marks them "Hidden to
  keep the map clear · tap to show".
- An explicit `visible: true` always wins. A user toggle is kept in the hash (`on=`/`off=`) as in v0.

### 1.3 Lenses

- Lens chips replace the raw time slider and vibe dial in the collapsed sheet (§2.3). A chip is ≥ 44 px tall, with
  emoji + label, and at most 4 sit in one scrollable row.
- Selecting a lens:
  1. sets `time` and `vibe` when given;
  2. applies its `weights` over the base criteria weights; a missing key keeps its base weight;
  3. shows the `show` layers and hides the `hide` layers. These are temporary: leaving the lens restores them. The
     user's own toggles win;
  4. filters areas features to those whose `lens` is in `areas`;
  5. applies `budget` if given;
  6. re-ranks and re-generates the verdict and the why-cards;
  7. emits `lens {id}`;
  8. writes `l=<id>` to the hash.
- Tapping the active chip again returns to the base state (no lens).

### 1.4 Goodness, ranking and ties (engine, `question.js`)

For criterion `c` and option `o` with value `x`, with meta merged from defaults → metrics.json → the criterion's own
keys:

```
if good/bad anchors known:     g = clamp((x - bad) / (good - bad), 0, 1)        // works for lower-is-better: good < bad
else if cap known:             g = clamp(x / cap, 0, 1)            (better=higher)
else:                          min-max across the options; all equal → 0.5
missing x                      g = 0.5, confidence low
```

Default anchors when neither metrics.json nor the criterion has them:

| unit / format | good | bad | threshold |
|---|---|---|---|
| `pct` (0-1 percentiles) | 0.7 | 0.3 | 0.05 |
| `min` (walking) | 3 | 15 | 2 |
| `m` (distance) | 200 | 1200 | 100 |
| `dB` | 55 | 70 | 3 |
| counts (`_<N>min`, `_<N>m`, `blocks`) | `cap` (default 20) | 0 | 3 |

- **Ties.** Two options tie on `c` when `|x_a - x_b| < threshold`, or when both are at or past `cap`. The leader set
  `L_c` holds every option tied with the best value. A **sole leader** is `|L_c| = 1`.
- **Score.** `S_o = Σ w_c·g_o,c / Σ w_c` over criteria with `w_c > 0`. Rank by `S` descending. A difference under
  0.03 is a tie; tied options keep the `options.ids` order.
- **Weights** come from the base, then the lens, then the user's Tune sliders (§2.3). The result is written to the
  hash as `w=key:3,key:1`.

### 1.5 Owner

- Engine: the ranking, defaults and lenses.
- Scripts: `validate` checks shape and refs; `uw question` (§13) scaffolds the block from metrics.json.

---

## 2. Verdict strip

### 2.1 Config

```jsonc
"verdict": {
  "mode": "auto",                  // "auto" (engine generates from metrics) | "authored" (lines below, verbatim)
  "facts": 2,                      // auto: phrases per option line (1-3)
  "persona": true,                 // auto: add "Light sleepers: A · Night owls: C" when ≥ 2 lenses have a persona and disagree
  "lines": [                       // authored mode (or pinned lines in auto mode via "pin": true)
    { "ref": "hotels:lore", "text": "quietest nights · MRT 3 min", "cites": ["quiet_night_blocks", "walk_min_mrt"], "lens": "sleep" }
  ]
}
```

With no `verdict` key and a `question` present, the default is `{ "mode": "auto", "facts": 2, "persona": true }`.

### 2.2 Auto generation (engine)

For each option, in rank order (max 5 lines; `plan-route`/`find-place` per §1.2):
1. Take the criteria where the option is the **sole leader**, sorted by weight descending. Weight-0 criteria
   count, after the weighted ones. Use `phrase.lead`.
2. If fewer than `facts` phrases: add the option's highest-goodness criterion with `g ≥ 0.6`, using
   `phrase.value`.
3. If still none: use `phrase.value` of the top-weight criterion. This yields neutral text like "MRT 6 min".
4. Line = `<letter> <short name> · <p1> · <p2>`. Append ` (est.)` once if any cited criterion has basis `estimated`.
5. `cites` = the criterion keys used. Store it on the line model, and emit it in `verdict {lines}`.

**Persona line:**
- For each lens with a `persona`, find the #1 option under that lens's weights.
- If at least two personas pick different options, add `Light sleepers: A · Night owls: C`.
- Otherwise add `Best by your weights: A`.

**Short name:** feature `short`, else `name_en` with leading/trailing "Hotel", "The" and "Taipei" removed and cut to 2
words, else `name`.

**Example.** taipei-stay, using today's data plus `uw areas`:
```
A Lore · quietest nights · MRT 3 min (est.)
B Via · greenest doorstep (est.)
C Everstar · liveliest nights (est.)
Light sleepers: A · Night owls: C
```

### 2.3 Layout (collapsed sheet, phone)

Peek, top to bottom:
1. `ask`, or the title, on one line.
2. The verdict lines. Each line is 1 row, ≥ 44 px tap target, letter chip in the option colour, ellipsis on
   overflow. Tapping a line selects the option.
3. The persona line (small).
4. The lens chips row with a **Tune ⚙** chip at its end.
5. The tab bar.

**Peek height:**
- Peek may grow to fit, but never past 38% of the viewport height.
- If it would, lines beyond the 3rd collapse into "+2 more" (tap = half snap).
- The subtitle and the air chip leave peek when a question exists; they move into Tune.

**Tune ⚙** is a popover anchored to the sheet. Desktop shows it inline in the side panel. It holds:
- the time slider and vibe dial from v0;
- up to 3 weight sliders for the top-weight criteria (0-3 in steps of 1), with live re-rank;
- a share bar showing each criterion's share of the total weight;
- the line "Sorted by your weights. Source and commission are never factors.";
- the air chip.

Without `question`, the v0 header is unchanged.

### 2.4 Validate rules (scripts)

| id | Rule | Level |
|---|---|---|
| V1 | Every authored line has non-empty `cites`, and every cited key is a criterion key or a metric present on the `ref` feature | error |
| V2 | Every number in an authored `text` (regex `\d+([.,]\d+)?`) equals a formatted value of a cited metric on that ref (formatted the way the engine would: `pct` → %, `m` → m/km, `min` rounded). Digits inside letters/ids are exempt | error |
| V3 | A line citing a metric with basis `estimated` contains `est` | error |
| V4 | Banned words in any verdict, why, area or note text: `unsafe, dangerous, sketchy, dirty, illegal, unlicensed, bad area, crime` (EN) and `危險, 違法, 非法` | error |
| V5 | `ref` resolves to an option | error |
| V6 | Auto mode: every criterion has a value on ≥ 2 options (otherwise it can't differentiate) | warning |

**Owner:** engine (generation, layout); scripts (V1-V6 in `validate`).

---

## 3. Pin tiers, rank, budgets, lettered options

### 3.1 Tier per layer

`layers[].tier`: `"option" | "support" | "context"`.

**Defaults when `question` exists:**
- the options layer → `option`;
- layers referenced by a criterion, a lens `show`, plan items, or a points layer with ≤ 12 features that a card
  mentions → `support`;
- every other points/heat layer → `context`.

**Without `question`:** every points layer is `support` and budgets are off. This keeps the v0 look.

### 3.2 Rendering per tier (engine, `layers.js`)

| | option | support | context |
|---|---|---|---|
| Mark | 40 px letter badge (canvas: filled circle in letter colour, white bold letter, 2 px white ring, soft shadow). `letters:false` → 40 px emoji badge | v0 badge at 30 px (emoji + colour) | 9 px dot (MapLibre `circle` layer, colour = layer colour, 1.5 px white stroke, opacity 0.85). At z ≥ 16.5 the dot becomes the v0 `s` badge |
| Label | always: short name under the badge (text-optional), + live price pill when offers exist (§9.7) | only at z ≥ 15.5, when selected, or when revealed by a mention | never (the card names it) |
| Collision | `icon-allow-overlap: true`, `icon-ignore-placement: true`, `text-allow-overlap: false` | `icon-allow-overlap: false`, `icon-padding: 2`, `icon-ignore-placement: false` | circles do not collide; budget limits them |
| `symbol-sort-key` | `rank` (1…n) | `100 + priority` | — |
| Hit area | 44 px (invisible circle layer `uw-<id>-hit`, radius 22) | 44 px | 32 px at dots; nearest within 22 px wins |
| Cluster | never | as configured | ignored (dots instead); `kind: explore` keeps clusters |

**Draw order** is fixed by tier, regardless of config order: grid → areas fills → lines → routes → context dots →
support symbols → areas labels → option symbols → selection ring. Config order holds within a group.

**Letter colours** (set by the theme's `--uw-letter-a` … `--uw-letter-e`; also used for the Compare columns, verdict
chips, list rows and card heads): instafy `A #007acc · B #a16207 · C #c0264e · D #0f766e · E #55524c`, neutral
`A #2563eb · B #ea580c · C #7c3aed · D #0d9488 · E #db2777`. They do not mean good or bad. A feature's `color` never
overrides a letter colour. The emoji appears in the card head next to the letter.

### 3.3 Rank and priority

- Option `rank` = current score rank (§1.4).
- Support and context `priority` = the feature's `rank` property if present; else distance in metres to the nearest
  option, so closer features come first. `find-place` uses score.
- **Budget** `{option: 5, support: 10, context: 80}` is the default.
  - Overrides: `question.budget`, then the active lens `budget`, then `layers[].budget` (a per-layer cap inside its
    tier).
  - Support and context budgets are **shared across layers in the tier**. The engine keeps the top-N features by
    priority, interleaved across layers, and filters the rest with a `["in", ["get","id"], ["literal", ids]]`
    filter.
  - The budget is recomputed on load, on lens/weight change and on selection. It is not recomputed on pan; panning
    must not reshuffle pins.
- **Budget-hidden features:**
  - They stay in the Places tab under "show all N".
  - Search reaches them.
  - Selecting one shows it (selected features are always shown).

### 3.4 Notes over pins (fix, all sites)

- **With a question:** notes whose `at` is an option item are not drawn as bubbles. Their text goes into that
  option's why-card as an `editorial` line, unless it repeats a generated line.
- **Remaining bubbles:**
  - `layoutNotes()` must also avoid the screen boxes of rendered option and support symbols (from
    `queryRenderedFeatures`, padded to 44 px).
  - Placement tries, in order: right, left, above, below, collapse to the 24 px emoji (offset 26 px up-right of the
    anchor).
  - If the emoji still overlaps an option pin, it is hidden.
  - Acceptance: `signal.notes_over_pins == 0` in default, night (`t=22`) and selected states.

### 3.5 Context layers: hidden until mentioned

**A card "mentions" a layer when:**
- a why-line or bar cites a metric whose metrics.json `layer` is that layer;
- or a key fits the patterns `nearest_<layer>_m`, `walk_(min|km)_<layer>`, `<layer>_<N>min` or `<layer>_<N>m`.

**On selecting an option:**
- **Reveal:** for each mentioned hidden layer, show only the referenced feature as a support-tier symbol with its
  label. The referenced feature is found by `id_key`, else `nearest_<layer>_id`, else the nearest feature computed
  in the engine.
- **Linked items:** show linked routes, e.g. the `mrtwalk` route whose `for` matches.
- **Layers tab:** the layer row reads "Showing 1 for A · Show all".
- **Undo:** clearing the selection or selecting another option undoes the reveal. A user toggle makes it permanent.

**Owner:** engine; scripts (`enrich` writes `nearest_<layer>_id`, metrics.json `layer`).

---

## 4. Why-cards ("why this fits you")

### 4.1 Line model

```jsonc
{ "mark": "check" | "cross" | "neutral",
  "text": "Quietest nights",                // ≤ 40 chars, from criterion label / phrase.lead
  "value": "13 quiet blocks vs 5 / 0",      // the number(s), formatted; compared options in letter order
  "basis": "estimated", "confidence": "low",
  "source": "OpenStreetMap via uw feel/areas", "scale": "inside the 10-min walk",
  "cites": ["quiet_night_blocks"] }
```

### 4.2 Generation (engine)

For a selected option, using the active weights:
- **✓ lines (≤ 2):** criteria with `g ≥ 0.6`, or sole leadership, sorted by `w × g`.
- **✗ line (≤ 1):** the criterion with the largest `w × (1 - g)` where `g ≤ 0.4`, or where the option is last by
  more than the threshold.
- **Trade-off (1 sentence):** `Trade-off: <cross text> (<value>, <basis word>)`, e.g.
  `Trade-off: busy road at the door (~72 dB est.)`.
  - If there is no cross, use the lowest-goodness criterion with "but".
  - If every criterion is high: "No clear trade-off among what you weighted."
- **Authored lines:** feature property `why` (an array of line objects) or `question.why["<id>"]` is shown first and
  counts toward the limits. Validate V1-V4 apply to them, using `cites`.

**Values:**
- One number for the option, plus the others in letter order when ≤ 3 options: `MRT 3 min (B 6 · C 9)`.
- Counts past `cap` show as "plenty (30+)".

### 4.3 Card layout (replaces the v0 order for option and support cards)

1. **Head:** letter chip (or badge), name, local name, licence chip (§8.3).
2. **Doorstep photo** (§7) or the "No street photo within 40 m" box.
3. **Why lines.** Each line is one row: mark icon (✓ green-neutral `#15803d`, ✗ `#b45309`, never red), text, value,
   basis chip. The trade-off sentence follows.
4. **Checked facts:** records rows (§9.7), with freshness badges and ↻.
5. **Actions:** 👍 Pick, 👎 Nope, Walk it, then bound intents with `ui: card` (§9.1). Up to 4 visible, the rest
   under ⋯.
6. **Link-outs row** (§5).
7. **"All numbers ▾"**: the v0 metric bars, collapsed by default when why lines exist.
8. **"How we know ▾":** one line per cited metric: label · method (`metrics.json[key].source` + scale) · basis ·
   as_of.
9. **Footer:** sources (v0).

Context cards (dots) show the head, a one-line subtitle, the link-outs and the footer. They have no why lines.

**Owner:** engine.

---

## 5. Link-outs

The engine computes link-outs in `links.js` from the feature's coordinates and properties. It makes no network
call and never embeds anything from Google or Apple.

### 5.1 Inputs

Feature properties, all optional except the geometry:
- `name`, `name_en`, `address`, `area`
- `place_id`: a Google place id, stored by a later gateway
- `entrance`: `[lng,lat]`, the door if mapped
- `sv_viewpoint`: `[lng,lat]`, a camera point on the street, written by `uw doorstep`
- `sv_heading`: degrees, camera → door, written by `uw doorstep`

### 5.2 URLs

`lat,lng` order inside the URLs is lat first. Coordinates are rounded to 6 decimals.

| key | Label | URL |
|---|---|---|
| `google` | Google Maps ↗ | `https://www.google.com/maps/search/?api=1&query=<q>` where `q` = `"<name> <address or area>"` (URL-encoded) if a name exists, else `<lat>,<lng>`; add `&query_place_id=<place_id>` when present |
| `streetview` | Street View ↗ | `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=<vlat>,<vlng>&heading=<h>&pitch=0&fov=80` where `v` = `sv_viewpoint` or the feature point, and `h` = `sv_heading` (omit `heading` when unknown) |
| `apple` | Apple Maps ↗ | `https://maps.apple.com/?q=<name>&ll=<lat>,<lng>` |
| `lookaround` | Look Around ↗ | `https://maps.apple.com/look-around?coordinate=<vlat>,<vlng>` + `&heading=<h>` when known. Shown on Apple devices (`/iPhone|iPad|Macintosh/` UA) or when `links.lookaround: true` |
| `directions` | `<label>` ↗ (default "Transit directions ↗") | `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>&travelmode=transit` + `&origin=<lat>,<lng>` when `links.directions.from` resolves |
| `panoramax` | Street photo ↗ | the photo's `viewer_url` (§7) when a photo exists |

The scripts builder checks once, by hand, that each URL form opens the right thing on a phone (iOS Safari and
Android Chrome). Record the result in `reference/config.md`. If the Apple `look-around` path does not open, fall back
to `https://maps.apple.com/?ll=<lat>,<lng>&z=19` and note it.

### 5.3 Config

```jsonc
"links": {
  "show": ["streetview", "google", "directions", "lookaround"],   // order = row order; default this list
  "layers": ["hotels"],                     // default: option + support layers; context cards get ["google"] only
  "directions": { "label": "To Taipei Main ↗", "to": "here", "from": { "layer": "sights", "id": "taipei-main" }, "mode": "transit" }
}
```

- `directions.to: "here"` (default) means the item is the destination.
- `from`, when set, is a ref resolved by the engine.
- A layer can override with `layers[].links: false | ["google"]`.

**Rendering:**
- A horizontal row of ≥ 44 px chips with `target=_blank` and `rel="noopener noreferrer"`.
- Each tap emits `link {layer, id, kind, url}`.
- The v0 single "Open in Maps" action is replaced by this row whenever `links` resolves to anything. The default is
  on for v2 configs; v0 configs keep the old button.

**Owner:**
- Engine: builds and renders the URLs.
- Scripts: the `uw doorstep` command (§7.1).

---

## 6. Named areas and the expert grid

### 6.1 `uw areas`

```
uw areas <site> [--grid feel] [--lens quiet_night,lively_night,green] [--within walk] [--options hotels]
                [--top 0.2] [--min-cells 3] [--max 5] [--smooth 2] [--names '{"quiet_night-1":"Dadaocheng back lanes"}']
                [--layer areas] [--json]
```

**Built-in lenses** (field, direction, verdict text, time window):

| lens | field | dir | verdict | time |
|---|---|---|---|---|
| `quiet_night` | `calm_night` | high | "Quiet at night" | [19, 30] |
| `lively_night` | `lively_night` | high | "Lively at night" | [18, 26] |
| `quiet_day` | `calm_day` | high | "Calm by day" | [6, 19] |
| `lively_day` | `lively_day` | high | "Busy by day" | [8, 20] |
| `green` | `green` | high | "Green and leafy" | — |
| `amenities` | `amenities` | high | "Everything nearby" | — |

A custom lens is `--lens key=<field>:<high|low>:<"Verdict text">`.

**Algorithm**, per lens:
1. Take the land cells (`water != true`) at or above the `1 - top` quantile of the field.
2. Find 8-connected components on the `c<col>-<row>` ids. Drop components with fewer than `--min-cells` cells.
3. Score each component by `cells × mean(field)` and keep the top `--max`.
4. **Polygon:** union the cell squares, then fill holes of ≤ 2 cells. Round it by running Chaikin `--smooth` times
   on the outer ring after a +0.25-cell buffer. A component's ring must not leave its cells' bbox by more than 0.3
   cell.
5. **`label_at`** = polylabel (pole of inaccessibility) of the polygon.
6. **Naming:**
   - One Overpass query for `place~"neighbourhood|quarter|suburb"` nodes and named `highway~"primary|secondary|tertiary"`
     ways in the bbox.
   - `place` = the nearest place node inside the polygon or ≤ 300 m from `label_at`, using `name:en`, else `name`.
     Romanisation is the agent's job via `--names`.
   - `name` = `"<place>"`, else `"near <street>"` (the longest street inside), else `"Area <n>"`.
   - `name_local` = the zh name when it differs.
   - `needs_english: true` when no Latin-script name was found. Validate S7 flags it.
7. **Option counts:** with `--within <walkLayer> --options <layer>`, for each option, count the lens's top cells
   whose centroid lies inside that option's walk polygon (`for == option id`). Write `<lens>_blocks` onto the option
   feature, e.g. `quiet_night_blocks: 13`, plus a metrics.json entry (basis `estimated`, threshold 3, unit
   "blocks").

**Output** `data/areas.geojson` (an owned file, ODbL), one Polygon feature per area:

```jsonc
{ "id": "quiet_night-1", "name": "Dadaocheng", "name_local": "大稻埕", "lens": "quiet_night",
  "verdict": "Quiet at night", "time_from": 19, "time_to": 30,
  "why": "16 blocks among the quietest 20% of this map at night; no main road inside (est.)",
  "basis": "estimated", "confidence": "medium",        // high never; medium when cells ≥ 8 and field sd within area < 0.12; else low
  "cells": 16, "share": 0.052, "mean": { "calm_night": 0.88, "lively_night": 0.21, "green": 0.35 },
  "options": { "lore": 13, "via-loft": 5, "everstar": 0 },   // top cells inside each option's walk area
  "label_at": [121.5112, 25.0601], "rank": 1, "needs_english": false }
```

The file's top level holds `uw`, `attribution: "© OpenStreetMap contributors"`, the `method` text, and
`lenses: [...]` (what was run). The `why` text is generated from numbers only; it uses no adjectives beyond the
verdict.

### 6.2 Engine rendering (`type: "areas"` with `verdict` properties)

The engine detects `role: "verdict"` on the layer, or features carrying a `verdict` property.

**Drawing:**
- **Fill:** layer colour by lens. Defaults: quiet `#0d9488`, lively `#db2777`, green `#16a34a`, calm-day `#0891b2`,
  busy-day `#ea580c`. Opacity 0.16, fading to 0.08 at z ≥ 16.
- **Edge:** a soft line (`line-blur: 4`, width 6, opacity 0.35). No hard outline.
- **Label** at `label_at`, on two lines: `<verdict>` bold 13 px, then `<name>` 11 px. Halo 2 px. The label is
  dropped first in collisions (`symbol-sort-key` 50, `text-optional`). It is drawn above support pins and below
  options.

**Behaviour:**
- **Time window:** `time_from`/`time_to` apply as on v0 points, but only while the time slider is enabled.
- **Lens filter:** only features whose `lens` is in the active lens's `areas` show. With no lens, all show, unless
  more than 5 would show; then only the top-ranked lens per time window shows.
- **Tap** opens an area card:
  - head: verdict + name;
  - `why`, with its basis chip and confidence;
  - "Inside the 10-min walk of: A 13 · B 5 · C 0 blocks";
  - "Show the evidence" turns on the expert grid, clipped to the area's bbox view.

### 6.3 Grid as an expert layer

When an areas layer with verdicts exists, or when `layers[].expert: true` is set:
- **Visibility:** the grid starts hidden in group "Expert", with the title suffix "(est.)".
- **Classes:** when shown, it uses 3 classes instead of the continuous ramp: `low < 0.33 ≤ mid < 0.66 ≤ high`.
  Colours: low `#cbd5e1` @0.25, mid `#5eead4` @0.40, high `#059669` @0.55.
- **Smoothing:** 3×3 smoothing is computed by the engine at load from the `c<col>-<row>` ids (centre weight 0.4,
  neighbours 0.075 each, missing or water neighbours skipped and weights renormalised), per sub-score. Smoothed
  fields replace raw ones for colouring. Tap cards still show raw values plus "smoothed with neighbours".
- **Fading:** cells whose centroid is outside the union of the options' linked walk areas render at 0.3× opacity.
  Inside/outside is computed once at load and stored in feature-state `inside`.
- **On-map legend:** a 1-line pill top-left (below the safe area, ≥ 44 px tall, tappable → Layers), shown while the
  grid is visible: `■ calm ■ mixed ■ lively · est. at 23:00`. The label follows vibe and time.
- **No expert grid** (v0 sites, no areas layer): keep the v0 ramp, but apply the smoothing and the on-map legend.
  This fixes the earlier finding that 26% of neighbouring cells jump >30 points, for everyone.

`uw feel --smooth` is **not** needed; the smoothing lives in the engine. Do not add it.

**Owner:** scripts (`uw areas`); engine (§6.2, §6.3).

---

## 7. Doorstep and street photos

### 7.1 `uw doorstep` (street facts + link-out heading)

```
uw doorstep <site> --layer hotels [--max-dist 60] [--json]
```

One Overpass query for `highway` ways within 80 m of each feature. Main candidates are
`residential|living_street|unclassified|tertiary|secondary|primary|trunk|service|pedestrian`; footways are used only
if nothing else is found.

Per feature it writes:
- `sv_viewpoint` [lng,lat]: the nearest point on the nearest candidate way, at most `--max-dist` m away.
- `sv_heading`: the bearing from the viewpoint to the door (`entrance`, if the feature has one, else its point),
  0-359.
- `street_name`, `street_name_local`, `street_class`. The class is `lane` for residential, living_street, service
  and pedestrian; `main` for primary, secondary and trunk; `street` otherwise.
- `main_road_m`: the distance to the nearest primary/secondary/trunk way, in metres.

It also writes metrics.json entries for `main_road_m` (basis `counted`, label "Main road", better higher) and
`street_class` (not numeric, display only). This gives the why fact "lane (巷) · main road 60 m".

### 7.2 `uw photos`

```
uw photos <site> --layer hotels [--radius 40] [--instances osm-tw,xyz] [--max-age-years 6] [--prefer 360] [--json]
```

**Search** (per feature, polite, cached):
1. **Facing:** `GET https://api.panoramax.xyz/api/search?place_position=<lng>,<lat>&place_distance=0-<radius>&limit=20`.
   This returns pictures that look at the place. The target point is `entrance`, else the feature point.
2. **Fallback, if empty:** `GET …/api/search?bbox=<±radius box>&limit=40`, filtered to distance ≤ radius. Results are
   marked `facing: false` unless the picture is 360°, because a 360° picture always faces the door.
3. **Pick** by: facing, then 360°, then newest `datetime`, then nearest. Keep up to 2 alternates.
4. If nothing is found within the radius, record the nearest picture distance from one wider search (≤ 150 m) as
   `nearest_m`, for honesty text only. Never show that picture.

**Field mapping** from a search feature (verified 11 Oct 2026 against `panoramax.osm.tw` via `api.panoramax.xyz`):

| photos.json | Panoramax |
|---|---|
| `id` | `id` |
| `instance` | `links[rel=via].instance_name` (e.g. `osm-tw`) |
| `thumb_url` | `assets.thumb.href` (500 px) |
| `sd_url` | `assets.sd.href` (2048 px; used by the 360 viewer; CORS allows any origin) |
| `is_360` | `properties["pers:interior_orientation"].field_of_view == 360` |
| `captured_at` | `properties.datetimetz` (fallback `datetime`), ISO with offset |
| `heading` | `properties["view:azimuth"]` |
| `author` | `providers[role=producer].name` (fallback `properties["geovisio:producer"]`) |
| `licence` | `properties.license` → shown as "CC BY-SA 4.0"; `licence_url` from `links[rel=license].href` |
| `viewer_url` | `https://<instance host>/#focus=pic&pic=<id>` (instance host from the `via` link href). The scripts builder checks that one opens on a phone; if the hash form is wrong, use the instance's documented permalink and record it in `reference/data-sources.md` |
| `lng`, `lat` | geometry |

**Computed fields:**
- `distance_m`;
- `bearing_to_item` (photo → target);
- `yaw_to_item` = `bearing_to_item - heading`, normalised to [-180, 180); the 360° viewer opens here;
- `facing`;
- `night`: captured after local sunset or before sunrise, computed from lat/lng with a standard NOAA solar formula.

**`data/photos.json`** (an owned file):

```jsonc
{
  "uw": { "cmd": "photos", "generated_at": "2026-10-11T15:00:00Z", "args": { "layer": "hotels", "radius": 40 } },
  "attribution": "Street photos: Panoramax contributors (CC BY-SA 4.0)",
  "radius_m": 40,
  "items": {
    "hotels:lore": {
      "status": "found",
      "target": [121.511048, 25.063418],
      "photo": { "id": "…", "instance": "osm-tw", "thumb_url": "https://panoramax.osm.tw/api/pictures/…/thumb.jpg",
                 "sd_url": "https://panoramax.osm.tw/api/pictures/…/sd.jpg", "viewer_url": "https://panoramax.osm.tw/#focus=pic&pic=…",
                 "is_360": true, "captured_at": "2026-01-14T15:02:10+08:00", "author": "…", "licence": "CC BY-SA 4.0",
                 "licence_url": "https://spdx.org/licenses/CC-BY-SA-4.0.html", "distance_m": 12, "heading": 88,
                 "bearing_to_item": 301, "yaw_to_item": -147, "facing": true, "night": false, "lng": 121.5111, "lat": 25.0635 },
      "alternates": [ /* same shape, ≤ 2 */ ]
    },
    "hotels:everstar": { "status": "none", "target": [121.524733, 25.0502], "nearest_m": 112,
                         "searched": { "radius_m": 40, "instances": ["osm-tw"], "at": "2026-10-11T15:00:00Z" } }
  }
}
```

**Config:**
- `"photos": { "data": "data/photos.json", "layers": ["hotels"], "viewer": "pannellum" }`.
- Default `data` is `data/photos.json` when the file exists.
- `viewer` is `"pannellum"` (default) or `"link"` (no embedded viewer; open `viewer_url`).

### 7.3 Engine (`photos.js`)

**Card**
- **Thumbnail** at 16:9, full card width. `loading=lazy`, `referrerpolicy=no-referrer`, `alt` = `"Street photo near <name>"`.
- **Overlay**, bottom-left: `Jul 2026 · 12 m · ◐ 360°`, or `· facing away` when not facing. Night photos get 🌙.
- **Credit** under the thumbnail: `© <author> · CC BY-SA 4.0 · Panoramax` linking `viewer_url`. Always visible.
- **No photo** (status `none`): a 16:9 neutral box reading "No street photo within 40 m". When `nearest_m` exists,
  add a small second line, "nearest is 112 m away". Then a Street View ↗ chip.
- **Never** fall back to a farther or older photo without saying so.

**360 viewer**
- **Opening:** tapping the thumbnail opens a full-screen overlay. The overlay has its own close button (44 px,
  top-right, safe-area aware), Esc closes it, and `history.pushState` lets Android back close it.
- **360° photos:** pannellum is lazy-loaded from `engine/vendor/pannellum/` on first open. It runs with
  `type: equirectangular`, `panorama: sd_url`, `yaw: yaw_to_item`, `hfov: 90`, `autoLoad: true`,
  `showControls: false` and `compass: false`. A button "Look at the door" re-centres on `yaw_to_item`.
- **Flat photos:** an `<img>` with pinch-zoom (CSS `touch-action: pinch-zoom`).
- **Credit bar:** visible at the bottom the whole time, with "Open in Panoramax ↗".
- **Events:** emits `photo {layer, id, photo_id, action: "open"|"close"}`.

**Compare "Doorstep" row** (first row after the verdict row when photos exist):
- one 4:3 thumbnail per column, with date and distance;
- or the text cell "No street photo within 40 m";
- tapping opens the viewer.

**Credits:** the photos file's `attribution` joins the map credits while any photo is on screen.

**Owner:**
- Scripts: `doorstep`, `photos`, vendoring pannellum 2.5.6 from the npm tarball (`build/pannellum.js`,
  `build/pannellum.css`, LICENSE) into `starter/engine/vendor/pannellum/`.
- Engine: `photos.js`.

---

## 8. Adapters (Taiwan first)

### 8.1 Mechanism: `uw adapter`

```
uw adapter list
uw adapter <name> <site> [adapter flags] [--refresh] [--json]
uw adapter <name> --help
```

An adapter is `scripts/adapters/<name>.mjs`:

```js
export const meta = { name: 'tw-hotels', describe: '…', sources: [{ id: 'data.gov.tw/7780', licence: 'OGDL-Taiwan-1.0', url: '…' }],
                      help: '…', flags: { layer: 'string', radius: 'number', refresh: 'bool' } };
export async function run(ctx, args) { /* returns { summary, wrote: [paths] } */ }
// optional, for handlers: export async function lookup(ctx, query) / nearby(ctx, query)
```

`ctx` is created by `cmd-adapter.mjs` and holds:
- `site` from `openSite`;
- `fetch` (net.mjs: UA, retries, cache);
- `cacheDir`: `~/.cache/uw/<adapter>/`, so large datasets are shared across sites. It holds a dataset file and
  `meta.json {fetched_at, source_updated}`, refreshed when older than 24 h or on `--refresh`;
- `loadLayer` and `writeOwnedLayer`;
- `setProps(layer, id, props)`, which respects `"uw"` ownership: adapters may add prefixed props (`tw_*`) and the
  generic `licence` object to any layer;
- `writeRecords(file, records)`, via `records.mjs` (validates, merges and bumps `data/version.json`);
- `metrics.merge(entries)`;
- `log(line)`.

**Adapter rules:**
- Adapters never overwrite a non-prefixed property.
- Adapters write records with `prov.lane: "open"` or `"official"` only.
- Every output carries the dataset's attribution.

### 8.2 `tw-hotels`

```
uw adapter tw-hotels <site> --layer hotels [--radius 300] [--refresh] [--records] [--json]
```

**Sources:**
- **National 旅館民宿 DB** (data.gov.tw 7780, updated daily): `https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Hotel-json.zip`.
  - Fields: `HotelID, HotelName, AlternateNames, PositionLat, PositionLon, HotelClasses, PostalAddress, Telephones,
    TotalRooms, LowestPrice, CeilingPrice, ServiceStatus, WebsiteURL, UpdateTime`, plus others.
  - Unzip with `lib/zip.mjs`.
  - Some fields are nested objects or arrays (`PostalAddress`, `Telephones`). Normalise them.
- **Taipei 一般旅館名冊** (data.gov.tw 135464):
  `https://data.taipei/api/dataset/4d7d0b46-2e90-4ee7-b000-c0f2f3a37651/resource/3cea29db-66b1-4ab5-886c-4cafd3e1dcbc/download`.
  - Fields: `縣市代碼, 專用標識編號, 旅館名稱, 電話或手機號碼, 營業地址, 客房最低定價, 客房最高定價, 房間數`.
  - It has no coordinates.
  - Detect the encoding (UTF-8 BOM or Big5 → decode with `TextDecoder('big5')`) and the format (CSV or JSON).
- **Licence id:**
  - From the register: `專用標識編號` formatted as `臺北市旅館<n>號`.
  - From the national DB: search the record's text fields, excluding `HotelName` and `Description`, for
    `/(\S{2,3}[市縣])?(觀光)?旅館\d+號|民宿\d+號/`. Record which field matched.
  - Example: one Taipei hotel's `816號` is only in the national DB.

**Normalisation** (`twnorm.mjs`):
- fullwidth → halfwidth;
- `台 → 臺`;
- strip spaces and punctuation;
- Chinese numerals in 段 → digits;
- addresses → `{city, district, road, section, lane, alley, number}`, by regex on `路|街|大道`, `段`, `巷`, `弄`, `號`;
- phones → digits only, `+886` → `0`, drop extension;
- names: strip `旅店|酒店|飯店|旅館|大飯店|商旅|hotel|inn|the|taipei|台北|臺北` and branch suffixes such as `館`, then
  compare with bigram Jaccard on both zh and en (`name`, `name_en`, `aka`).

**Matching** (`match.mjs`), per option feature:
- **Candidates:** national DB rows within `--radius` m (default 300), plus register rows whose phone or normalised
  address matches.
- **Signals:**
  - `phone` (exact);
  - `address` (road + section + number equal);
  - `name` (sim ≥ 0.5);
  - `geo` (distance ≤ 60 m).
- **Confidence:**
  - `high`: (`phone` or `address`) and (`name` or `geo`).
  - `medium`: `name ≥ 0.6` and distance ≤ 150 m, or `address` alone.
  - `low`: the best candidate with sim ≥ 0.4. Shown only as "possibly".
  - Otherwise: none.

**Writes:**
1. Feature props:
   - `tw_hotel_id`;
   - `tw_register`: `"taipei-135464"` | `"national-7780"` | both, comma-joined;
   - `tw_rooms`;
   - `tw_price_min` and `tw_price_max` (TWD, filed);
   - `tw_class`: `一般旅館` | `觀光旅館` | `民宿`;
   - `tw_match`: `{confidence, by: [...], dist_m, candidate: "<register name>"}`;
   - `tw_as_of`: the dataset `UpdateTime` or the register release date;
   - the generic `licence` object:
     ```jsonc
     "licence": { "status": "registered" | "not_found" | "uncertain", "id": "臺北市旅館166號",
                  "label": "Registered hotel", "class": "hotel" | "tourist_hotel" | "bnb",
                  "source": "data.gov.tw 7780 · Taipei register 135464", "as_of": "2026-09-09",
                  "url": "https://data.gov.tw/dataset/135464", "confidence": "high" }
     ```
2. metrics.json: `tw_rooms` (basis `registry`), `tw_price_max` (basis `filed`, label "Filed max rate", unit
   "NT$", note "legal ceiling, not a typical price").
3. With `--records`: `data/records/tw-hotels.json` claims (§9.6): `licence`, `registered_rooms`,
   `filed_price_min`, `filed_price_max`, with `basis` `registry`/`filed` and `prov.lane: "open"`.
4. Attribution, appended to config `attribution` if absent: `旅館資料：交通部觀光署、臺北市政府 (data.gov.tw，政府資料開放授權條款第1版)`.
   The OGDL licence is void without the credit, so validate errors if it is missing while `tw_*` props exist.

**Wording rules** (validate V4 + engine):
- A miss is `not_found`. Never call it illegal or unlicensed.
- A low-confidence match is `uncertain`, never `registered`.

### 8.3 Licence chip (engine)

Shown in the card head and as a Compare "Licence" row whenever any option has `licence`:

| status | Chip | Style |
|---|---|---|
| `registered` | `✓ Registered hotel · 臺北市旅館166號` (label by class: hotel / tourist hotel / B&B) | neutral green text, no fill |
| `uncertain` | `ⓘ Possibly 臺北市旅館166號 · match medium` | grey |
| `not_found` | `ⓘ Not found in register (checked 9 Sep 2026)` | grey; never red, never a warning icon |

Tapping the chip opens a small sheet with the source, as_of, match signals and the dataset link.

### 8.4 `tw-night-markets`

```
uw adapter tw-night-markets <site> [--bbox …|--around hotels --radius 2500] [--layer nightmarkets] [--areas] [--add-osm] [--json]
```

**Source:** Taipei 攤販集中場 (data.gov.tw 121594):
`https://data.taipei/api/dataset/c013d9ec-a550-46bd-ac60-45f085930706/resource/4874f750-b972-4c42-ad76-986960670c70/download`.
Fields: `stitle, xbody, xstartTime, xendTime, xAddress, GTag_longitude, GTag_latitude`.

**Hours:**
- Parse from `xbody` (patterns `營業時間[:：]?\s*(\d{1,2})[:：]?(\d{2})?\s*[-~至到]\s*(\d{1,2})…`, plus `24:00` and
  `凌晨`).
- Write `time_from` and `time_to` with wrap past 24, e.g. 17 → 25. Also write `hours_text`, the original text,
  ≤ 60 chars.
- If unparseable: no window (shown all evening as `time: [17, 24]` at layer level) and `hours_known: false`.

**Output:** `data/nightmarkets.geojson`, points (an owned file):
- props: `id`, `name`, `name_en`, `kind: "night_market"`, `emoji: "🏮"`, `time_from`, `time_to`, `hours_text`,
  `address`, `district`, `source`;
- `name_en` comes from an OSM match within 150 m when available.

**`--add-osm`:** merges OSM `amenity=marketplace` features whose name matches `夜市|night market` and are not already
present. This adds Shilin, which the dataset lacks. They are marked `source: "OpenStreetMap"`.

**`--areas`:**
- For markets that match an OSM way or area (`amenity=marketplace`, `highway=pedestrian` named 夜市) within 150 m,
  write `data/nightmarket-areas.geojson` with the real polygon or street line buffered by 8 m, labelled
  `geometry: "osm"`.
- Never invent an outline for markets without a match. They stay points.

**Engine (glow):** a points layer with `style.glow: true` draws, during the feature's time window only, a soft halo
under the pin: a circle with radius 26 px, `circle-blur` 0.9, layer colour at 0.35, fading in over the first
half-hour of the window. This makes markets "light up" on the time slider. The card chip reads
`🏮 18:00–00:00 · night market`.

**Enrich:** `uw enrich --nearest nightmarkets --route-to nightmarkets` already gives "night market on your street"
facts.

**Attribution:** `夜市資料：臺北市政府市場處 (data.gov.tw，政府資料開放授權條款第1版)`.

**Owner:** scripts (both adapters, cmd-adapter); engine (licence chip, glow).

---

## 9. Two-way binding

### 9.1 Declaring intents: `bound.json` (canonical) or `map.config.json` → `intents`

`bound.json` sits at the site root. It is the manifest Instafy and `uw host` read. `map.config.json` may hold an
`"intents": { … }` object with the same per-intent shape, for UI-only intents. When both define a name, `bound.json`
wins and validate warns.

```jsonc
{
  "version": 1,
  "intents": {
    "check_registry": {
      "label": "Check licence", "emoji": "🪪",
      "describe": "Look this hotel up in Taiwan's official hotel registers",
      "params": {                                   // JSON-Schema subset (§9.2)
        "type": "object", "required": ["ref"], "additionalProperties": false,
        "properties": { "ref": { "type": "string", "maxLength": 120 }, "name": { "type": "string", "maxLength": 120 },
                        "lnglat": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
                        "refresh": { "type": "boolean" } } },
      "prefill": { "ref": "$item.ref", "name": "$item.name", "lnglat": "$item.lnglat" },
      "ui": ["card", "compare-cell:licence"],       // where buttons appear (below)
      "layers": ["hotels"],                         // for card/long-press: which layers' items get the button
      "target": { "records": "data/records/check_registry.json", "layer": "hotels" },
      "pending": "item",                            // item | layer | cell:<attr> | none
      "confirm": false,                             // true = engine asks "Send to the agent?" before emitting
      "cooldown_s": 20, "timeout_s": 90,
      "sources": ["data.gov.tw/7780", "data.taipei/135464"],   // provenance sources a result may carry (host checks)
      "handler": "pack:check_registry"              // uw host only: "pack:<name>" = skill handlers/, or a site path "handlers/x.mjs"
    },
    "find_hotels_nearby": {
      "label": "Registered hotels nearby", "emoji": "🏨",
      "params": { "type": "object", "required": ["at"], "additionalProperties": false,
        "properties": { "at": { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
                        "radius_m": { "type": "integer", "minimum": 100, "maximum": 2000, "default": 600 },
                        "max": { "type": "integer", "minimum": 1, "maximum": 30, "default": 15 },
                        "refresh": { "type": "boolean" } } },
      "prefill": { "at": "$pin.lnglat|$item.lnglat|$view.center" },
      "ui": ["map-context", "sheet-header", "card-more"],
      "target": { "records": "data/records/find_hotels_nearby.json", "layer": "nearby_hotels",
                  "create": { "type": "points", "title": "Registered hotels nearby", "tier": "support",
                              "style": { "emoji": "🏨", "color": "#64748b", "size": "m" }, "group": "Found" } },
      "pending": "layer", "timeout_s": 120,
      "sources": ["data.gov.tw/7780"], "handler": "pack:find_hotels_nearby"
    }
  },
  "results": { "files": ["data/records/check_registry.json", "data/records/find_hotels_nearby.json"],
               "poll_s": 3, "sse": true },
  "attribution": []
}
```

**UI placements (`ui[]`):**

| value | Where | Notes |
|---|---|---|
| `card` | Card actions row, after Pick/Nope/Walk | Only for items in `layers`. The primary style goes to the first `card` intent |
| `card-more` | Card ⋯ menu, and a **long-press on the card head** (500 ms) | The same list as ⋯ |
| `sheet-header` | A chip at the end of the lens row (or the header in v0 layout) | Prefill uses `$view.*` and `$state.*` |
| `map-context` | The long-press / right-click pin card ("What's it like here?") | Prefill uses `$pin.lnglat` |
| `compare-cell:<attr>` | ↻ on Compare cells showing claim `<attr>`; also on card "Checked facts" rows | This is "check again"; see §9.8 |
| `list-row` | ⋯ on Places rows | optional |

**Prefill tokens** (`|` = first one defined):
- `$item.ref`, `$item.id`, `$item.layer`, `$item.name`, `$item.lnglat`, `$item.<prop>`;
- `$pin.lnglat`;
- `$view.center`, `$view.bbox`, `$view.zoom`;
- `$state.hour`, `$state.lens`, `$state.weights`;
- `$options.refs`, the list of option refs.

**Missing params:** if a `required` param is still missing after prefill, the engine opens a small inline form
generated from the schema before emitting. The form supports string, number, integer, boolean, enum, and
`format: date` / `date-time`; it gets labels from `title`, and its inputs are ≥ 44 px.

**Visibility:**
- Intent buttons render only when a listener is detected (§9.4): a parent `hello`, `window.instafy`, or
  `__uw/health`.
- `#bind=1` in the hash forces them on for tests.
- Without a listener, they are absent, not greyed. Snapshots of static sites stay clean.

### 9.2 JSON-Schema subset (`schema-lite.mjs`; the engine carries an identical copy in `bind.js`)

**Supported keywords:**
- `type` (object, string, number, integer, boolean, array, null; also an array of types);
- `properties`, `required`, `additionalProperties: false`;
- `enum`, `const`, `default`;
- `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`;
- `items`, `minItems`, `maxItems`;
- `format` (`date`, `date-time`, `uri`);
- `title`, `description`.

Unknown keywords make `validate` error, so the subset never silently ignores a constraint. The serialised params
must be ≤ 4 KB.

### 9.3 Intent out: message and transports (`bind.js` + `bridge.js`)

**Message (v2):**

```jsonc
{ "source": "instafy-map", "v": 2, "type": "intent",
  "id": "int_lx3k9a_7f2c",                // "int_" + base36(Date.now()) + "_" + 4 random base36; unique per click
  "name": "check_registry", "params": { "ref": "hotels:lore", "name": "Lore Hotel", "lnglat": [121.511048, 25.063418] },
  "ui": "card", "ref": "hotels:lore",      // where it was clicked and on what (null for header/map)
  "by": "Kim",                            // optional, unverified hint only (from host hello.user or the local name); hosts MUST stamp their own
  "site": { "title": "Which Taipei hotel?", "path": "/taipei-stay/" },
  "state": { "hour": 23, "lens": "sleep" },
  "at": "2026-10-11T15:04:05.120Z" }
```

**Transports.** All four fire for the same message with the same `id`, in this order. Hosts must dedupe by `id`.
1. **Parent postMessage:** if `window.parent !== window`, `parent.postMessage(msg, targetOrigin)`. `targetOrigin` is
   the origin from the parent's `hello` if one arrived, else `'*'`. The message holds no secrets.
2. **Window event:** `window.dispatchEvent(new CustomEvent('uw:intent', {detail: msg}))`. The general `uw:event` is
   also fired, with `{type:'intent', payload: msg}`.
3. **Instafy API:** if `typeof window.instafy?.intent === 'function'`, call `window.instafy.intent(msg)`. If it
   returns a Promise, treat its resolved value as an ack (§9.4). Today no `window.instafy` exists; this is a hook
   for the Instafy-side design.
4. **Dev host:** if `__uw/health` answered at load (§10), `fetch('__uw/intent', {method:'POST', body: JSON, headers:
   {'content-type':'application/json'}})`. The URL is relative to the document. The 202 JSON body is an ack.

**After emitting:**
- The engine sets the pending state (§9.5) and emits the local `intent` event.
- It enforces `cooldown_s` per (name, ref). During cooldown the button shows "Sent".

### 9.4 Results in: messages and transports

**Host → map message** (`messages.schema.json`):

```jsonc
{ "source": "instafy-host", "v": 2,
  "type": "hello" | "ack" | "progress" | "results" | "done" | "error" | "command",
  "id": "int_lx3k9a_7f2c",               // the intent id (absent for hello/command)
  "job": "job_123",                      // optional host job id
  "status": "queued" | "needs_confirm" | "rejected" | "running",   // ack only
  "reason": "quota",                     // ack rejected / error
  "progress": { "step": 1, "of": 2, "message": "Searching data.gov.tw 7780", "source": "data.gov.tw/7780" },
  "records": [ /* §9.6 */ ],             // results only; may be partial, many results per job
  "files": { "data/records/check_registry.json": 13 },  // optional: files the host persisted + version
  "error": { "code": "not_found" | "timeout" | "policy" | "upstream" | "invalid", "message": "≤ 140 chars" },
  "user": { "name": "Kim" },             // hello only
  "capabilities": { "intents": ["check_registry"] },    // hello only: names the host will run (others hidden)
  "command": { "name": "select" | "flyTo" | "setLens" | "setTime" | "highlight", "args": {} }  // command only
}
```

**Accepted transports** (all on, all deduped by `(id, record key, as_of)`):
1. **postMessage from the parent.** Accept only if `event.source === window.parent`,
   `data.source === 'instafy-host'`, and (when `bind.parentOrigins` is set) `event.origin` is in that list.
2. **SSE** from the site's own host: `new EventSource('__uw/events')`, opened only if `__uw/health` answered.
   - Event names are the `type` values; `data` is the same JSON.
   - Reconnect relies on the browser plus `Last-Event-ID`.
3. **Polling `data/version.json`:**
   - Shape: `{ "v": 13, "updated_at": ISO, "files": { "<path>": <v> }, "jobs": { "<intent id>": "running"|"done"|"error" } }`.
   - Fetched with `cache: 'no-store'`. The interval is `results.poll_s` (default 3 s) while anything is pending, else
     30 s, and paused while the tab is hidden.
   - On any file version greater than the one loaded, re-fetch that file and merge.
   - A job state in `jobs` resolves pending items for hosts that only write files, which is the Instafy apply model.

**Load:** at start the engine loads every file in `results.files` and in `version.json.files`. A 404 is silent.

**Acks and hello:**
- `hello` marks a listener as present and stores `user`, `capabilities` and `parentOrigins`.
- `ack status: needs_confirm` changes the pending line to "Waiting for confirmation in chat" (the Instafy tray).
- `ack rejected` clears the pending state, and the reason shows as a toast.
- **No listener:** if no ack or progress arrives from any transport within 5 s and no transport claimed delivery,
  the engine clears the pending state and toasts "No agent is connected to this map. Open it in Instafy, or run uw
  host."

**`command` messages** let a host drive the map, e.g. chat → "show me C". The whitelist:
- `select {ref}`;
- `flyTo {ref|lnglat|bbox}`;
- `setLens {id}`;
- `setTime {hour}`;
- `highlight {refs, ms}`, which pulses those pins.

Anything else is ignored.

### 9.5 Pending and progress UI

| `pending` | What shows while running |
|---|---|
| `item` | The item's pin gets a small 3-dot badge at the top-right (static under reduced motion). In the card, the rows the intent targets (`compare-cell` attrs, or a "Checking…" row) render as shimmering skeleton lines |
| `cell:<attr>` | Only that Compare cell / Checked-facts row is a skeleton |
| `layer` | The target layer's toggle in Layers shows a spinner. A slim progress line sits under the sheet header with the latest `progress.message`, `step/of` and a Cancel ✕ (Cancel emits intent `cancel {id}` over the same transports) |
| `none` | Toast only |

- **Progress** updates the status line text. It reads, e.g., "Checking data.gov.tw · 1/2", never just "loading".
- **Done** clears the skeletons. If no records came for an item, the line becomes "Nothing new found · as of 15:04".
- **Error** gives an inline message with ↻ "Try again", which re-emits with the same params and a new id.
- **Timeout** (`timeout_s`) behaves like an error with code `timeout`.
- **Re-rendering:**
  - Pending state is per intent id. Several jobs may run at once.
  - Pins, card, Compare, list and verdict re-render when records merge. Use `refreshPanels()` and the
    source-data update, not a layer re-add.
  - If records change a criterion value, the verdict and ranking update live.
  - The change is announced in an ARIA live region: "Lore: licence found".

### 9.6 Records (`uw.records@1`)

**File** `data/records/<name>.json`:

```jsonc
{ "schema": "uw.records@1", "uw": { "cmd": "host|adapter", "updated_at": "…" },
  "attribution": ["旅館資料：交通部觀光署 … (政府資料開放授權條款第1版)"],
  "records": [
    { "type": "claim", "cid": "clm_tw_lore_licence", "ref": "hotels:lore", "attr": "licence",
      "value": "臺北市旅館166號", "status": "ok", "label": "Hotel licence", "basis": "registry", "confidence": "high",
      "match": { "confidence": "high", "by": ["address", "name"], "dist_m": 18, "candidate": "樂爾公寓" },
      "prov": { "source": "data.taipei/135464", "source_label": "Taipei hotel register", "lane": "open",
                "url": "https://data.gov.tw/dataset/135464", "observed_at": "2026-10-11T15:04:09Z", "observed_by": "uw-host",
                "as_of": "2026-09-09", "ttl_s": 86400, "class": "stored",
                "license": { "store": "full", "attribution": "臺北市政府 (OGDL-Taiwan-1.0)" },
                "adapter": "tw-hotels@0.2", "intent": { "name": "check_registry", "params": { "ref": "hotels:lore" }, "id": "int_lx3k9a_7f2c" } } },
    { "type": "claim", "cid": "clm_tw_lore_pmax", "ref": "hotels:lore", "attr": "filed_price_max", "value": 15000, "unit": "TWD",
      "label": "Filed max rate", "note": "filed max rate, not a live price", "basis": "filed", "confidence": "high", "prov": { "…": "…" } },
    { "type": "offer", "oid": "off_liteapi_lore_2410", "ref": "hotels:lore",
      "variant": { "checkin": "2026-10-24", "checkout": "2026-10-27", "guests": 2, "rooms": 1 },
      "seller": { "name": "LiteAPI", "trust": "curated" },
      "price": { "amount": 10260, "currency": "TWD", "kind": "total", "taxes_included": "yes" }, "refundable": true,
      "handoff": { "url": "https://…", "label": "Book via partner", "affiliate": true },
      "basis": "live", "prov": { "source": "liteapi", "lane": "official", "observed_at": "…", "ttl_s": 21600, "class": "live", "sandbox": true, "…": "…" } },
    { "type": "item", "iid": "tw7780_C3_0123", "layer": "nearby_hotels", "kind": "lodging",
      "name": { "local": "某某旅店", "en": "…" }, "geo": { "lng": 121.5123, "lat": 25.0611 },
      "keys": { "tw_hotel_id": "C3_0123" }, "props": { "tw_rooms": 32 }, "prov": { "…": "…" } }
  ] }
```

**JSON Schema.** Ship it as `schemas/records.schema.json`; both `records.mjs` and the engine's sanitiser follow it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://instafy.dev/schemas/uw.records@1.json",
  "type": "object",
  "required": ["schema", "records"],
  "properties": {
    "schema": { "const": "uw.records@1" },
    "uw": { "type": "object" },
    "attribution": { "type": "array", "items": { "type": "string", "maxLength": 300 }, "maxItems": 10 },
    "records": { "type": "array", "maxItems": 2000,
      "items": { "oneOf": [ { "$ref": "#/$defs/claim" }, { "$ref": "#/$defs/offer" }, { "$ref": "#/$defs/item" } ] } }
  },
  "$defs": {
    "rid": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,96}$" },
    "ref": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[^\\s]{1,120}$" },
    "basis": { "enum": ["measured", "routed", "counted", "estimated", "registry", "filed", "live", "brand", "user_note", "editorial", "modelled", "inferred"] },
    "confidence": { "enum": ["high", "medium", "low"] },
    "text": { "type": "string", "maxLength": 140 },
    "https": { "type": "string", "maxLength": 2000, "pattern": "^https://|^http://(localhost|127\\.0\\.0\\.1)(:|/)" },
    "prov": {
      "type": "object",
      "required": ["source", "lane", "observed_at", "ttl_s"],
      "additionalProperties": false,
      "properties": {
        "source": { "type": "string", "maxLength": 80 },
        "source_label": { "type": "string", "maxLength": 80 },
        "lane": { "enum": ["link", "official", "open", "capture", "feed", "assist", "local"] },
        "url": { "$ref": "#/$defs/https" },
        "observed_at": { "type": "string", "format": "date-time" },
        "observed_by": { "type": "string", "maxLength": 80 },
        "observer": { "type": "string", "maxLength": 80 },
        "as_of": { "type": "string", "maxLength": 32 },
        "ttl_s": { "type": "integer", "minimum": 0 },
        "ttl": { "type": "integer", "minimum": 0 },
        "class": { "enum": ["stored", "live"] },
        "license": { "type": "object", "additionalProperties": false, "properties": {
          "store": { "enum": ["none", "ids", "ttl", "full"] },
          "attribution": { "type": "string", "maxLength": 300 },
          "url": { "$ref": "#/$defs/https" } } },
        "adapter": { "type": "string", "maxLength": 60 },
        "job": { "type": "string", "maxLength": 80 },
        "intent": { "type": "object", "required": ["name"], "properties": {
          "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,47}$" },
          "params": { "type": "object" }, "id": { "type": "string", "maxLength": 40 } } },
        "snapshot_sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "sandbox": { "type": "boolean" },
        "logged_in": { "const": false }
      }
    },
    "claim": {
      "type": "object",
      "required": ["type", "cid", "ref", "attr", "basis", "prov"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "claim" }, "cid": { "$ref": "#/$defs/rid" }, "ref": { "$ref": "#/$defs/ref" },
        "attr": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,47}$" },
        "value": { "type": ["string", "number", "boolean", "null"], "maxLength": 140 },
        "unit": { "type": "string", "maxLength": 12 },
        "label": { "type": "string", "maxLength": 60 },
        "note": { "$ref": "#/$defs/text" },
        "status": { "enum": ["ok", "not_found", "uncertain", "error"] },
        "basis": { "$ref": "#/$defs/basis" }, "confidence": { "$ref": "#/$defs/confidence" },
        "match": { "type": "object", "additionalProperties": false, "properties": {
          "confidence": { "$ref": "#/$defs/confidence" },
          "by": { "type": "array", "items": { "enum": ["id", "phone", "address", "name", "geo"] }, "maxItems": 5 },
          "dist_m": { "type": "number", "minimum": 0 }, "candidate": { "type": "string", "maxLength": 120 } } },
        "prov": { "$ref": "#/$defs/prov" }
      }
    },
    "offer": {
      "type": "object",
      "required": ["type", "oid", "ref", "price", "prov"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "offer" }, "oid": { "$ref": "#/$defs/rid" }, "ref": { "$ref": "#/$defs/ref" },
        "vid": { "$ref": "#/$defs/rid" },
        "variant": { "type": "object", "additionalProperties": false, "properties": {
          "checkin": { "type": "string", "format": "date" }, "checkout": { "type": "string", "format": "date" },
          "guests": { "type": "integer", "minimum": 1, "maximum": 30 }, "rooms": { "type": "integer", "minimum": 1, "maximum": 10 },
          "label": { "type": "string", "maxLength": 80 } } },
        "seller": { "type": "object", "required": ["name"], "additionalProperties": false, "properties": {
          "name": { "type": "string", "maxLength": 80 }, "trust": { "enum": ["curated", "unknown"] } } },
        "price": { "type": "object", "required": ["amount", "currency"], "additionalProperties": false, "properties": {
          "amount": { "type": "number", "minimum": 0 }, "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
          "kind": { "enum": ["total", "nightly", "from", "regular", "sale", "member"] },
          "taxes_included": { "enum": ["yes", "no", "unknown"] } } },
        "refundable": { "type": ["boolean", "null"] },
        "availability": { "enum": ["in_stock", "out", "unknown"] },
        "handoff": { "type": "object", "required": ["url"], "additionalProperties": false, "properties": {
          "url": { "$ref": "#/$defs/https" }, "label": { "type": "string", "maxLength": 40 }, "affiliate": { "type": "boolean" } } },
        "label": { "type": "string", "maxLength": 80 },
        "basis": { "$ref": "#/$defs/basis" },
        "prov": { "$ref": "#/$defs/prov" }
      }
    },
    "item": {
      "type": "object",
      "required": ["type", "iid", "kind", "name", "geo", "prov"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "item" }, "iid": { "$ref": "#/$defs/rid" },
        "layer": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$" },
        "kind": { "type": "string", "maxLength": 40 },
        "name": { "type": "object", "additionalProperties": false, "properties": {
          "local": { "type": "string", "maxLength": 120 }, "en": { "type": "string", "maxLength": 120 } } },
        "geo": { "type": "object", "required": ["lng", "lat"], "additionalProperties": false, "properties": {
          "lng": { "type": "number", "minimum": -180, "maximum": 180 }, "lat": { "type": "number", "minimum": -90, "maximum": 90 } } },
        "keys": { "type": "object", "additionalProperties": { "type": "string", "maxLength": 120 } },
        "props": { "type": "object", "maxProperties": 30, "additionalProperties": { "type": ["string", "number", "boolean", "null"], "maxLength": 140 } },
        "prov": { "$ref": "#/$defs/prov" }
      }
    }
  }
}
```

The schema keeps the JSON-Schema subset of §9.2 plus `oneOf`, `$ref`, `$defs`, `maxProperties` and
`additionalProperties` as a schema. `schema-lite.mjs` supports these too, so validate and host need no dependency.

**Merge rules** (`records.mjs` and engine `records.js`; identical logic):
- **Key:** `cid` / `oid` / `iid`.
- **Same key:** the newer `prov.observed_at` wins.
- **Different keys with the same `(ref, attr, prov.source)`, for claims:** the newer replaces the older. The older
  is dropped from display and, at the host, from the file.
- **Item records** become features in `item.layer` (or `target.layer`), with `properties.id = iid`, `name` =
  `name.local`, `name_en`, plus `props` and `keys`. If the layer is missing and the intent declares `target.create`,
  the engine creates it with `uw.addLayer`.
- **Unknown refs** are kept but not shown, and a console warning is logged. They are not an error, because a
  feature may arrive later.
- **Aliases:** `observer` maps to `observed_by` and `ttl` to `ttl_s`. Writers emit the canonical names.

**Sanitising in the engine.** Records are untrusted data:
- strings via `textContent` only;
- URLs only `https:`, or `http:` for localhost;
- numbers must be finite;
- at most 2000 records per file and 200 KB per file; larger files are ignored with a toast;
- record text never reaches `innerHTML`, `eval` or the config.

### 9.7 How records render

| Record | Card | Pin | Compare | Freshness |
|---|---|---|---|---|
| claim `licence` | licence chip (§8.3) | — | "Licence" row | `· data.gov.tw · 9 Sep 2026` (stored: date of `as_of`) |
| claim (other) | "Checked facts" row: `<label> <value unit> · <source_label> · <age>` + basis chip + note | — | row if a `compare.metrics[].key` is `claim:<attr>` or the claim's attr is a criterion | stored: `as_of` date; live: age |
| offer | "Prices" block, cheapest first among same currency + `taxes_included: yes` + same variant; others listed "not comparable" | option pins get a price pill under the label: `NT$10,260` | auto "Price" row (when offers exist), plus the variant label in the row header | `NT$10,260 · LiteAPI · 4 min` |
| item | creates features (support tier) | standard badge | — | the card footer shows `Found by <intent label> · <source_label> · <age>` |

- **Age format:** < 1 min "now"; < 60 min "N min"; < 24 h "N h"; else `D Mon` (`9 Sep`). Re-render every 30 s
  while visible.
- **Expired** (`now > observed_at + ttl_s`): dimmed 50% and suffixed `· expired`, with ↻ when an intent can refresh
  it.
- **Live offers** (`class: live`) are never written into share text, the URL hash, the snapshot verdict or the
  `pick`/`nope` payloads.
- **Labels:** `sandbox: true` adds a "sandbox" suffix chip. Offers whose seller has `trust: unknown` never get the
  cheapest mark or a verdict phrase.
- **"How this is sorted"** (Tune ⚙ and the Compare footer): "Weights shown above. Source, seller and commission are
  never factors." This is fixed text.

### 9.8 "Check again" = an intent

- Every claim and offer whose `prov.intent.name` is declared, and whose UI placement includes
  `compare-cell:<attr>` or `card`, gets a ↻ button (44 px) in its row or cell.
- Tapping it emits the original intent with the original `prov.intent.params`, plus `refresh: true` if the schema
  declares `refresh`, and `ui: "cell"`, `ref` and `attr` in the envelope.
- `pending` becomes `cell:<attr>` for that one emit.
- Records without `prov.intent`, such as adapter output written at build time, get ↻ only if an intent with
  `ui: compare-cell:<attr>` exists. Prefill then comes from the row's item.

### 9.9 Engine API and events (additions)

**API:**
- `uw.question`: the resolved config;
- `uw.rank()` → `[{ref, letter, score, g:{key:g}}]`;
- `uw.setLens(id|null)`, `uw.setWeights({key:w})`;
- `uw.intent(name, params, {ref, ui})` → id; it throws for undeclared names;
- `uw.ingest(msg)`: the same path as postMessage, for tests and custom.js;
- `uw.records(ref?)` and `uw.pending()`;
- `uw.links(layer, id)` → `[{kind, label, url}]`;
- `uw.signal()` → the report (§11).

**New events** (bridge `v: 1` shape, `type` as named):
- `lens {id}`;
- `weights {weights}`;
- `intent {id, name, params, ref, ui}`;
- `ack {id, status}`;
- `results {id, count, refs}`;
- `done {id}`;
- `error {id, code}`;
- `link {layer, id, kind, url}`;
- `photo {layer, id, photo_id, action}`;
- `verdict {lines:[{ref, letter, text, cites}]}`, emitted on change and debounced 500 ms.

**Owner:** engine (`bind.js`, `records.js`, UI); scripts (`schemas/*`, `records.mjs`, `schema-lite.mjs`, validate
of `bound.json`).

---

## 10. `uw host`: local dev host for the full loop

```
uw host <site|gallery-dir> [--port 4173] [--host 0.0.0.0] [--confirm] [--log] [--json]
```

It is a superset of `uw serve`, reusing `createStaticServer`. When given a gallery folder (like `examples/`), each
subfolder with a `bound.json` gets its own `<site>/__uw/*` endpoints.

**Endpoints** (relative to the site root; never served for dotfiles):

| Method + path | Does |
|---|---|
| `GET __uw/health` | `200 {ok:true, host:"uw-host", v:2, intents:[names with a resolvable handler]}` |
| `POST __uw/intent` | Body = the §9.3 message, ≤ 4 KB, `content-type: application/json`. Same-origin only: reject requests whose `Origin` header is set and differs from the host's own. Validate: `name` declared, handler resolvable, params pass the schema. Returns `202 {status:"queued", id, job}`; `400 {status:"rejected", reason}`; `404` for an unknown intent; `409 {status:"queued", job}` for a duplicate `id` (returns the existing job); `429` during cooldown. With `--confirm`, the job waits for `y` on the terminal (simulates the Instafy tray) and the ack is `needs_confirm` |
| `GET __uw/events` | SSE: `retry: 2000`, a `: ping` comment every 15 s, events `ack/progress/results/done/error` (data = §9.4 JSON, `id:` = monotonically increasing event number). `Last-Event-ID` replays from a 200-event ring buffer. **Every connected viewer gets every event:** this is the "live for everyone viewing" path |
| `GET __uw/jobs` | Debug: the last 50 jobs with state, timings and record counts |

**Handler contract.** `handlers/<name>.mjs` in the skill (`pack:<name>`) or a site-relative path:
- The host spawns `node <handler>` as a child process, with cwd = the site dir and env `UW_SITE`, `UW_CACHE`
  (`~/.cache/uw`) and `UW_INTENT_ID`.
- It writes one JSON object to stdin: `{ intent: <msg>, bound: <intent def>, site: { dir, config } }`.
- **The handler writes NDJSON to stdout**, one object per line:
  - `{"type":"progress","step":1,"of":2,"message":"…","source":"data.gov.tw/7780"}`
  - `{"type":"records","records":[…]}` (any number of times; partial results are welcome)
  - `{"type":"done","summary":"Found licence 臺北市旅館166號"}`
  - `{"type":"error","code":"not_found|upstream|invalid|policy","message":"…"}`
- stderr goes to the host log.
- **Handlers never write site files.** The host does the apply step:
  1. validate each record against `records.schema.json`;
  2. check that `prov.source` is in the intent's `sources` (if declared), and reject records whose `prov.lane` is
     not `open`, `official` or `local`;
  3. stamp `prov.intent` (name, params, id) and `prov.job`;
  4. merge into `target.records` (§9.6 rules; atomic tmp + rename);
  5. bump `data/version.json` (`v`, `files[path]`, `jobs[id]`);
  6. broadcast `results` with the accepted records, then `done`.

  Rejected records are logged and counted in `done` as `rejected: n`. This mirrors the Instafy "apply, no model"
  step.
- **Limits:**
  - 2 concurrent jobs per site;
  - identical `(name, params)` within 60 s coalesce into the running job, and the new id is attached to it, so both
    ids receive the events;
  - a `timeout_s` kill (SIGTERM, then SIGKILL after 3 s) followed by `error timeout`.
- **Cancel:** an intent named `cancel` with `{id}` kills the job and emits `error {code:"cancelled"}`.

**Handler 1: `check_registry`** (`handlers/check_registry.mjs`):
- **Params:** `{ref, name?, lnglat?, refresh?}`.
- **Steps:**
  1. Load the feature from the site's layer file.
  2. Progress 1/2: "Loading Taiwan hotel database (data.gov.tw 7780)". Use the `tw-hotels` adapter's `lookup()`,
     which downloads into `~/.cache/uw/tw-hotels/` on first use or when `refresh` is set.
  3. Progress 2/2: "Matching against the Taipei register (135464)".
- **Emits claims** with `basis: registry|filed` and `prov.lane: "open"`:
  - `licence`: status `ok` (value = the id), `uncertain` (value = the id, plus the match), or `not_found` (value
    null);
  - `registered_rooms`;
  - `filed_price_min` and `filed_price_max`, each with the note "filed rate, not a live price";
  - `prov.as_of` = the dataset date, `ttl_s` 86400, `url` = the dataset page, OGDL attribution.
- **Done** with a one-line summary.
- **Never:** `illegal`/`unlicensed` wording, and no `licence` claim at `confidence: low` without `status: uncertain`.

**Handler 2: `find_hotels_nearby`** (`handlers/find_hotels_nearby.mjs`):
- **Params:** `{at:[lng,lat], radius_m=600, max=15, refresh?}`.
- **Uses** the adapter's `nearby()`: national DB rows with coordinates within the radius and `ServiceStatus` open
  (if present), sorted by distance.
- **Emits:**
  - one `item` per hotel (`layer: nearby_hotels`, `kind: lodging`, names zh/en, `geo`, `keys.tw_hotel_id`,
    `props {tw_rooms, tw_class, distance_m}`);
  - claims `filed_price_max` and `filed_price_min` (ref = `nearby_hotels:<iid>`, `label: "Filed max rate"`,
    `note: "filed max rate, not a live price"`);
  - a `licence` claim when an id is present.
- **Streams** in batches of 5 so pins appear progressively.
- **Skips** hotels already matched to an option (same `tw_hotel_id`), and says so in the summary.

**The demo, which must work end to end:**
1. Run `uw host examples/taipei-stay`.
2. Open the page on a phone and tap **A Lore**. The card shows 🪪 **Check licence**.
3. Tap it. The licence chip and the Checked-facts rows show skeletons, and progress reads "Loading Taiwan hotel
   database · 1/2".
4. After ≤ 15 s cold or ≤ 2 s warm, the chip reads `✓ Registered hotel · 臺北市旅館166號`, the rows read
   `Filed max rate NT$15,000 · Taipei hotel register · 9 Sep 2026`, and a second phone viewing the same host sees
   the same update without reloading.
5. Long-press near Ningxia and pick "Registered hotels nearby". Grey 🏨 pins stream in, each card showing its filed
   rate range and licence.

**Owner:** scripts (`cmd-host.mjs`, both handlers, the `tw-hotels` `lookup`/`nearby` exports).

---

## 11. Clutter check: `uw snapshot --signal` and `uw validate --signal`

### 11.1 In-page report (`signal.js`, `uw.signal()`)

Computed on the current state over the **visible map rect**, which is the viewport minus the sheet (phone peek) or
the side panel:

```jsonc
{ "viewport": [390, 844], "visible_rect": [0, 0, 390, 560], "state": { "lens": "sleep", "hour": 23, "selected": null },
  "options": { "total": 3, "visible": 3, "under_sheet": 0 },
  "symbols": { "option": 3, "support": 4, "context_dots": 22, "cluster_bubbles": 0, "area_labels": 2, "notes": 1 },
  "basemap_labels": 18,                          // rendered symbol features from style (non-uw) layers
  "fill_coverage": 0.21,                         // share of a 24×40 sample grid hitting any site fill layer
  "notes_over_pins": 0,                          // note boxes intersecting option/support symbol boxes (44 px)
  "layers_without_legend": [],                   // visible site layers with none of: letters, on-map legend, `legend`, areas labels, or a Layers swatch + title
  "compare_rows_no_diff": ["parks_10min"],       // rows where all chosen values tie (§1.4)
  "labels_without_english": ["areas:quiet_night-2"],
  "verdict": { "present": true, "lines": 3, "uncited": 0 },
  "why": { "options_with_2plus_lines": 3 },
  "tap_targets_small": [],                       // visible interactive chrome elements < 44×44 (getBoundingClientRect)
  "noise": 11.5, "noise_limit": 12 }
```

`noise = support + cluster_bubbles + notes + 0.25 × context_dots`, and `noise_limit = 2 × options.visible + 6`.

### 11.2 Rules (same ids in both commands)

| id | Rule | Level |
|---|---|---|
| S1 | `noise ≤ noise_limit` on the phone view (default state and each lens) | fail |
| S2 | support ≤ budget.support; context_dots ≤ budget.context | fail |
| S3 | fill_coverage ≤ 0.45 (warn); ≤ 0.60 (fail) | warn/fail |
| S4 | basemap_labels ≤ 25 | warn |
| S5 | `layers_without_legend` empty | fail |
| S6 | `compare_rows_no_diff` empty in the shown rows (the engine hides them; a row with `always: true` warns instead) | fail |
| S7 | `labels_without_english` empty when `basemap.labels` is `en` or `both` (options, support labels, area names, verdict names) | warn (`--strict`: fail) |
| S8 | With `question`: verdict present in peek, `lines ≥ 1`, `uncited = 0` | fail |
| S9 | `notes_over_pins = 0` (default, `t=22`, option A selected) | fail |
| S10 | `tap_targets_small` empty | fail |
| S11 | All options visible and none under the sheet in the default view | fail |
| S12 | Compare shows ≤ 5 rows by default | warn |
| S13 | Every option has ≥ 2 why lines with a basis | warn |
| S14 | Every on-screen number in verdict/why/area text resolves to a metric or record (in-page check of the cited keys) | fail |

### 11.3 Commands

**`uw snapshot <site> --signal`:**
- Runs the normal desktop and mobile renders, then on mobile evaluates `uw.signal()` in these states: default,
  `#l=<each lens>`, `#t=22`, and option A selected.
- Writes `snapshots/signal.json` as an array of reports plus a rule summary.
- Prints one line per failing rule, e.g. `S1 noise 19.5 > 12 in lens "night": 9 support pins (mrt 6, gyms 3). Fix:
  set gyms tier "context" or lower question.budget.support.`
- Exits 1 on any fail.
- Also renders `snapshots/mobile-lens-<id>.png` for each lens.

**`uw validate <site> --signal`** is static and needs no browser. Checks:
- question refs and criteria present on options;
- weights;
- budgets ≥ options;
- verdict V1-V6;
- S5 from config (legend derivable);
- S6 from data (ties on chosen options);
- S7 from data (`name_en` missing, `needs_english`);
- photos.json credits complete (author, licence, captured_at, viewer_url on every photo);
- records files against the schema;
- `bound.json`: intents, schema subset, prefill tokens, handler resolvable, `ui` values, targets;
- OGDL attribution present when `tw_*` props exist;
- link-outs have coordinates.

Without `--signal`, the new checks run as warnings only, which keeps v0 compatibility.

**Owner:** engine (`signal.js`, the hiding of no-difference compare rows); scripts (`snapshot --signal`,
`validate --signal`).

---

## 12. Fixes that apply to every site

### 12.1 Dark band at the horizon in steep 3D

- **Repro:** `uw snapshot examples/taipei-stay --hash "@=121.5179,25.0568,15.5,30,72&t=14"`, plus the same with `t=22`.
- **Fix** in `look.js` `skyFor(dark, look)`:
  - `fog-color` = the look's current `background` colour, so the fog matches the land at the horizon.
  - `horizon-color` = that colour mixed 25% toward the sky colour.
  - `sky-horizon-blend: 0.5`, `horizon-fog-blend: 0.85`, `fog-ground-blend: 0.92`.
  - `atmosphere-blend` = `['interpolate',['linear'],['zoom'],0,1,6,0.6,9,0]`.
  - Call `setSky` on every look change and after style load. Today it is called only in `applyLook`.
- **Limits:**
  - Clamp `maxPitch` to 72 when `basemap.terrain` is false (today 75).
  - Also set `background` and `fog-color` together in the night look, so no unlit strip shows between the last tile
    row and the sky.
- **Acceptance:** in both PNGs, take the mean luminance per pixel row across the middle 60% of the width. No row in
  the top 45% of the map may be more than 18 L* darker than both the rows 12 px above and below it. Implement this as
  `--eval`-free logic in `snapshot --signal` (state `pitch72`), reported as `S15 horizon_band`.

### 12.2 Note bubbles covering pins

See §3.4. This applies with or without `question`.

### 12.3 Grid smoothing and on-map legend

See §6.3, last bullet.

**Owner:** engine; scripts (the S15 measurement in snapshot).

---

## 13. Scripts command summary (new or changed)

| Command | Status | Writes |
|---|---|---|
| `uw areas <site> --grid feel --lens … [--within walk --options hotels]` | new | `data/areas.geojson`, option props `<lens>_blocks`, metrics.json |
| `uw doorstep <site> --layer <id>` | new | props `sv_viewpoint`, `sv_heading`, `street_*`, `main_road_m`; metrics.json |
| `uw photos <site> --layer <id> [--radius 40]` | new | `data/photos.json` |
| `uw adapter list` / `uw adapter <name> <site> …` | new | per adapter (§8) |
| `uw host <site>` | new | records files, `data/version.json` (via handlers) |
| `uw question <site> --kind choose-one --options hotels --criteria quiet_night_blocks:3,walk_min_mrt:2,green:1 [--lenses sleep,night,move]` | new (P1) | the `question` block in map.config.json, labels/phrases from metrics.json; built-in lens presets `sleep` (23:00), `night` (20:00), `move` (09:00), `morning` (08:00); refuses keys missing on options |
| `uw enrich` | changed | adds `nearest_<layer>_id`, `walk_id_<layer>`, metrics.json entries |
| `uw validate [--signal]` | changed | §2.4, §11 |
| `uw snapshot [--signal]` | changed | `snapshots/signal.json`, lens PNGs |
| `uw new` | changed | starter `map.config.json` gets `"version": 2`; no question until the agent adds one |
| `uw upgrade` | changed | also copies `engine/vendor/pannellum/` |

Network etiquette is as in v0, with the UA bumped to `instafy-map-pack/0.2 (+https://instafy.dev)`:
- Panoramax: max 2 requests/s, cached per `(lng,lat,radius)` in `.uwcache/`.
- data.gov.tw / data.taipei / media.taiwan.net.tw: one download per dataset per 24 h, into `~/.cache/uw/`.

---

## 14. SKILL.md and reference changes (scripts builder; keep SKILL.md < 8 KB)

**Procedure:**
- Step 1 "Plan" gains: "write the question (kind, ask, 2-5 options, ≤ 4 criteria with weights, 2-3 lenses)".
- After `enrich`: `uw areas`, `uw doorstep` and `uw photos` for the options; in Taiwan, `uw adapter tw-hotels` and
  `tw-night-markets`.
- Then `uw question`.
- `validate --signal` and `snapshot --signal` replace the plain versions in steps 10-11.

**Hard rules:**
- **Rule 3** adds: "Never write verdict, why or area text by hand without `cites`; numbers must come from metrics or
  records."
- **New rule 8:** "Only declared intents run; results are records with provenance; never type a price or licence
  number."

**Reference:**
- `reference/config.md`: new sections for `question`, `verdict`, tiers, `links`, `photos`, areas, records, and
  bound.json.
- `reference/recipes.md`: recipe 0 becomes the v0.2 taipei-stay. Add "Bind a button to an agent" and "Run the loop
  locally with uw host".
- `reference/data-sources.md`: Panoramax (CC BY-SA, per-photo credit), data.gov.tw OGDL (credit is mandatory),
  Google/Apple link-outs (links only, nothing embedded).

---

## 15. Acceptance: `examples/taipei-stay` at v0.2

The example is upgraded in place, and its existing data stays. The upgrade:
1. Run `uw areas --lens quiet_night,lively_night --within walk --options hotels`, then
   `uw doorstep --layer hotels`, `uw photos --layer hotels` and `uw adapter tw-hotels --layer hotels --records`.
2. Run `uw adapter tw-night-markets --around hotels --radius 2500 --add-osm`. This replaces the `markets` layer's
   role; keep the old layer only if validate says it is still referenced.
3. Add the `question` from §1.1 and a `bound.json` with both intents from §9.1.
4. Set tiers: `cafes`, `parks` and `gyms` → context; `mrt` → context, revealed by mention; `metro` lines stay
   visible at 0.5 opacity.

**Pass when:**
- `validate --signal` and `snapshot --signal` exit 0, with zero console errors.
- The phone peek shows exactly this verdict, with the data as of 11 Oct 2026; new data may change the wording, not
  the mechanism:
  `A Lore · quietest nights · MRT 3 min (est.)` / `B Via · greenest doorstep (est.)` / `C Everstar · liveliest nights (est.)` /
  `Light sleepers: A · Night owls: C`.
- **Doorstep photos:** the Lore and Via cards show dated doorstep photos. Everstar shows "No street photo within
  40 m". Compare has a Doorstep row.
- **Licence:** Lore's card reads `✓ Registered hotel · 臺北市旅館166號`. Everstar shows `uncertain` or `registered`
  from the national DB, per the actual match, and never a negative word.
- **Signal counts:** at the default phone view, 3 lettered pins and noise ≤ 12.
- **Horizon:** the S15 check passes at pitch 72, by day and by night.
- **The §10 demo works**, including a second browser receiving the same SSE update.
- **The v0 examples** (`amsterdam-green-rail`, `daan-coffee-walk`, `taiwan-loop`) still pass plain `validate` and
  `snapshot`, and their PNGs differ only by the §12 fixes.

---

## 16. Out of scope for v0.2, and questions for the Instafy-side design

**Not in v0.2:**
- the Google Places UI Kit card;
- LiteAPI (the offer shape is ready; the adapter is not);
- Walk it with eyes;
- the hover lens;
- Grounding Lite;
- any agent-driven browsing.

**For the parallel Instafy workflow.** Things the map side assumes; please confirm or change them:
1. The host sends `hello` on iframe load. Without it, buttons stay hidden inside Instafy unless `window.instafy`
   exists.
2. The host stamps `by` itself and ignores the page's value.
3. The host persists results by writing `data/records/*.json` and bumping `data/version.json` (the apply step), so
   viewers outside the iframe and late joiners see them. postMessage `results` are an optional speed-up.
4. `ack.status: needs_confirm` is how the "Send to Octo" tray shows up in the map.
5. A record's `prov.lane` is chosen by the registry, never by the page.
6. Is `window.instafy.intent(msg) → Promise<ack>` the API shape you want?

---

## 17. Integration notes (11 Oct 2026): what shipped differs from the text above

These decisions reconcile the engine and scripts builds. Where they differ from an earlier section, this section wins.

- **Paths.** Handlers and schemas live under `scripts/` (`scripts/handlers/<name>.mjs`, `scripts/schemas/*.json`);
  `pack:<name>` resolves there. The engine's JSON-Schema subset is `engine/schema.js` (identical `validate()` and
  `applyDefaults()` to `scripts/lib/schema-lite.mjs`); the engine embeds a copy of `records.schema.json` in
  `records.js` (checked identical).
- **360° viewer.** The default is the engine's own WebGL viewer (`engine/pano.js`). `photos.viewer` is `"builtin"`
  (default), `"pannellum"` (only if `engine/vendor/pannellum/` is vendored; falls back to built-in) or `"link"`.
  Pannellum is not vendored in v0.2.
- **Finding `uw host`.** `uw host` marks every static response of a bound site with `X-UW-Host: 2`, and with
  `X-UW-Bound: 1` when the site has a `bound.json`. The engine probes `__uw/health` only after seeing `X-UW-Host` (or
  `bind.host: true`, or `#bind=host`), and loads `bound.json` when the config has `"bind"` or the response has
  `X-UW-Bound`. Other hosts (Instafy, static) need `"bind": true`; validate warns when it is missing.
- **No 404s before the first result.** `uw host` creates `data/version.json` and every declared records file (empty)
  at start. `uw snapshot` still ignores 404s on those paths for static hosts.
- **Side files** (metrics.json, photos.json, bound.json, records, version.json) are fetched only when the config
  refers to them, so static v0 sites never request them.
- **Context tier wins.** An explicit `"tier": "context"` keeps a layer hidden until a card mentions it, even when a
  criterion's metric names that layer (taipei-stay's `mrt`).
- **Area labels** use a light tint of the lens colour on the dusk/night looks (the full colour was unreadable).
- **`uw.signal()`** also reports `compare: {rows, more, hidden_ties}` (S12) and `verdict.unresolved_numbers` (S14);
  `snapshot --signal` uses both.
- **Intent messages.** `site.title` is cut to 120 characters and `site.path` to 300 (the host schema limits).
  `bound.json` may carry `parentOrigins`; the engine uses them when `bind.parentOrigins` is not set. The error code
  `cancelled` is part of `messages.schema.json`.
- **`add-point`** refuses (exit 2) a street address that resolves to a whole district or city; use the street part
  alone in local form (`"延平北路三段 4號"`).
- **Examples.** `examples/taipei-stay` is upgraded in place per §15 (question, areas, doorstep, photos, tw-hotels,
  tw-night-markets, bound.json with both intents); the other three examples run the v0.2 engine with their v0
  configs. `uw host examples` serves the gallery with the agent loop for taipei-stay.

## 18. Review fixes (12 Oct 2026): what changed after the two reviews and the example builds

These supersede the text above where they differ. Engine files: `question.js`, `engine.js`, `ui.js`, `bind.js`,
`records.js`, `bridge.js`, `layers.js`, `signal.js`, `photos.js`, `engine.css`. Scripts: `cmd-host`, `records`,
`cmd-question`, `cmd-areas`, `cmd-enrich`, `cmd-photos`, `tw-night-markets`, `tw-hotels`, both handlers, `cmd-site`
(`new`, `fit`), `cmd-serve` (snapshot), `snapshot-signal`, `validate`/`validate-v2`, schemas.

**Ranking and verdict (§1-§2).**
- `rankList` sorts strictly by score (only exact ties keep the given order); near-ties (< 0.03) are said in the
  persona line ("A and B are close"), never by reordering. The first verdict line is always the top score.
- `uw question` writes `options.ids` in rank order under the starting lens: letters follow the answer (A = best) and
  stay put across lenses. Validate warns when the top option is not A.
- Verdict lines carry `facts: [{ text, key, basis, caveat }]`; the UI tags each fact (`est.`, 🧭 routed, 📏 measured,
  🔢 counted, 🏛 registry/filed). `text` keeps " (est.)" after estimated facts only.
- Line building: weighted sole leads (heaviest first) → other weighted facts with goodness ≥ 0.6 → weight-0 sole leads;
  the worst of the options on a criterion weighted ≥ 2 (or the heaviest) becomes a caveat ("but loudest door at night,
  72 dB"), which takes the second fact's place. Lines wrap to two lines (`line-clamp: 2`), never "…".
- Phrases: `lead`, `value`, `worst`, `zero`, `cross`. Area-derived counts are worded as area facts ("quietest streets
  nearby", "Quiet streets within a 10-min walk"), door metrics as door facts ("Road noise at your door, night").
- Door vs walk area (`splitFor`): when an option's door (`noise_night_db` / `calm_night`; `lively_night`) and walk
  area (`calm_night_area`, `quiet_night_blocks`; `lively_night_area`, `lively_night_blocks`) sit at opposite ends of
  the options (3+), or two 0-1 estimates differ by ≥ 0.4, one fact says both ("noisiest door at night, but quietest
  walk area (est.)", cites both) in place of either; added when there is room or the lens weighs either; a neutral
  why line always. `uw question`'s sleep lens ranks on the door (3; added at weight 0 when not listed), the night
  walk area 1, calm by day 0; night keeps the walk area at 3.
- `question.watch`: measured facts about an option's surroundings (a night market 262 m away, its hours) → a ✗ why
  line and the caveat of the listed lenses. `uw question` adds one for a night-market layer.
- Estimated percentages rank and read against the map's own feel grid (percentile: "top 5%"), never a bare "95%";
  without a grid a word (very high … very low). Explicit `good`/`bad` anchors still rank.
- Headings: find-place "Top 5 of 445 <noun>"; plan-route a summary from the legs and stops ("🚆 9 stops · 13 nights
  · 10 rides by train & HSR · loop from Taipei") and `D1`… day lines (all days, "+11 more days", tap = that day at
  half height); find-area the plan's walk ("🚶 … 5 stops · 1.58 km · 21 min (routed)") and per area what it offers
  beyond its own verdict.
- Trade-off sentence relates the best and the worst line ("quietest streets nearby, but loudest door …, the worst of
  the 3"). Why lines wrap below 330 px (container query).

**Map (§3, §6).** Lens chips and Tune share one wrapping row (Tune is an icon without a clock). Setting a lens
re-frames when options are off screen. Option badges take part in placement (no label across a letter). Support
layers with ≤ 12 places are named from z13 (`labelZoom`). Night-market glow 0.6. Named-area labels that would run off
the screen or under the button column are hidden until panned in. With a verdict areas layer the basemap's village /
suburb / neighbourhood / quarter labels are hidden (`basemap.placeLabels: "all"` keeps them). plan-route legs number
their stops (dots = nights) with direction arrows (`numbered`). `n` or a keycap emoji on a point = a numeral disc.
Pick / Nope only on options. Toasts sit above the sheet on phones and leave at the first map touch.

**Areas, photos, enrich (scripts).** `uw areas`: quiet lenses drop cells within 150 m of a place open in their hours
(the night-market layer by default, `--avoid`); `<lens>_blocks` counts only drawn cells; names prefer a park inside
(green / quiet), a neighbourhood, a street (never the main road through a quiet area); `--names "English|中文"`;
`--near layer --radius m`. `uw enrich --nearest`: an area target (polygon, or a point with an OSM way/relation id) is
measured to its edge (0 = inside, `nearest_<L>_inside`, basis measured), with `nearest_<L>_hours` / `_kind`; stale
values are removed; feel metrics drop fixed anchors. `uw photos`: pictures taken from a bridge or expressway running the
way the camera faced, beside the door's street, are left out (`rejected_reason`); on-street pictures win.
`tw-night-markets`: `--around` is a circle per feature; English names only from the same market; `hours_label:
"Permitted vendor hours"`, `hours_basis: "registry"`. Validate A1: no quiet area may contain a night market open in
its hours.

**Records and binding (§8-§10).**
- Freshness: stored official data (`class: "stored"`) never expires on a TTL; it says "data as of …" and goes stale
  after `prov.refresh_days` (default 45). Live data and offers expire on `ttl_s` / `expires_at`.
- `tw-hotels` / `check_registry` emit one licence claim per register (with that register's holder name); the chip
  says "sources differ" when they disagree and the sheet lists both ("Registered as …"). Compare names each cell's
  register. `find_hotels_nearby` adds `licence_class`, a registered_rooms claim, the address and `name_note`.
- Offers: comparability key adds refundability; only taxes-known offers can be "Best price" ("Lowest seen (taxes
  unclear)" otherwise). `travel.offer@1` (`record.upsert`) maps to an offer on `<target or options layer>:<pid>`.
- A records file over 200 KB is read partially (newest first, items with their claims); `uw host` trims its files to
  180 KB, oldest groups first.
- Cooldown key (page and host): an item's ref, else the params with coordinates rounded to ~50 m. A refused repeat is
  `202 {status:"rejected", reason:"cooldown…", retry_after_s}`, never 429. "Check again" never sets `refresh`; handlers
  re-match against the ≤ 24 h cache.
- Job status only moves forward (a late POST "queued" never undoes "running"), except "needs_confirm" (a person is
  needed). Waiting for a person pauses `timeout_s`. A host that said hello may hold an intent: "sent to chat, waiting".
- Every host event carries `name`, `ref`, `ui`, `by` (host-stamped) and map-search `params`; other viewers show
  those jobs as pending ("Someone else: …"). `data/version.json` `jobs[id]` = `{ state, name, ref, params?, at, error?,
  summary? }`: polling viewers see running jobs, and the last error per item survives a reload until a later success.
- `done.summary` is kept: a layer job ends with its items framed, never hidden by the pin budget, the search radius
  drawn, and a dismissable summary chip (also for "nothing found"). Found layers rank after criterion layers in the
  budget. Buttons: "✓ <doneLabel> · now" during the cooldown, then "<againLabel>". The card's first `card` intent sits in
  the head next to the licence chip. `produces` marks every attribute a job writes as pending and gives each row ↻.
  `intents[].layers` may name a layer another intent creates.
- Instafy bind v1: the page sends `hello {siteId, manifestHash: "sha256:…" of bound.json}` (to the parent when
  embedded, and on an adopted v1 port), `intent.request`, `intent.cancel`, `intent.resume {from}` (last event id, kept
  per tab) and `session.show {iid, taskId}`; it handles `intent.accepted.plan` (per-source progress line),
  `task.needs_user` kinds (sign_in / captcha / confirm_cart / approve_origin, with "Show"), `record.expire`,
  `intent.done.counts` (partial outcome "1 of 2 sources answered (1 blocked)"), `browser.location` (pulse the matching
  pin). A v1 port carries only bind messages; UI events stay on the parent frame. The page no longer sends `by`.

**Signal rules added to `snapshot --signal`.** S16 lens chip covered or off screen; S17 verdict line cut off, or the
first line not the top score; S18 why-line pieces overlapping (new landscape state, `landscape-card.png`); S19 the
last agent results not visible (warn). S10 now includes inline links (a 44 px `::after` hit box counts). S4 counts
only the basemap's own vector-source labels; `uw.registerLayer(id, tier)` lets custom.js layers count.
