# Changelog

All notable changes to this pack. Versions follow [semantic versioning](https://semver.org/); the release tag is
`v<version>` and `skills/interactive-map/.instafy-pack.json` carries the same version.

## 0.1.7 (2026-10-28)

Fixes to 0.1.6.

- **Plain words in what the agent passes on.** `uw stay` told the agent to say its picks came "from public
  registers/OSM", and `uw snapshot` without a browser to say the map "was validated". Both lines are copied into the
  reply, so they now say "from OpenStreetMap and public registers" and that "the map's data was checked, but not how
  it looks".
- **No words in single-quoted `--props` left.** Three examples still put words in single-quoted JSON, which an
  apostrophe breaks as "Alfama's" did: a stop placed by hand (`"station_of":"<City>"`, as in "L'Aquila"), a place
  geocoded by its address (`"source":"<where the address came from>"`) and `uw validate`'s hint for a day with no
  sourced place. They use `--props-file -` with a quoted heredoc, as does "One base"'s area to stay in, whose note
  now goes in that object instead of a double-quoted `--note`.

## 0.1.6 (2026-10-28)

Fixes from the 28 Oct 2026 drive ("3 days in Lisbon … what to see each day").

- **A trip is days too.** `SKILL.md` sent "nights in one or more places" to `reference/itinerary.md`, so "3 days in
  Lisbon" took the steps for choosing a hotel: one neighbourhood as the only "hotel" and the days written into the
  pins' notes, with no plan. A trip is now days or nights somewhere ("what to see each day"), routed before Phase A,
  and `uw new` points a trip to the itinerary. `uw validate` fails while a stop asked for with nights (`--expect
  "Lisbon:3"`) has no plan. "One base" never pins the area as a hotel: with no stay found it pins the area as the
  recommendation, labelled as one.
- **Plain words on the map.** A place card and the Places list said OpenStreetMap's own classes ("Baixa · Suburb",
  "Belém · Administrative") and "Source: OpenStreetMap search (Photon) · osm.org/node/…". Area classes now read
  "Neighbourhood", "District", "Area", "Town" (a bare "yes" or "house" says nothing), and map data reads "Map data ©
  OpenStreetMap"; another source keeps its name without the lookup in brackets. A new map has no "neighbourhood feel
  layer" subtitle.
- **Props without shell quoting.** `uw add-point` and `uw set` take `--props-file <file>`, and `--props-file -` reads
  stdin, so a quoted heredoc carries "Alfama's" or quotes that single-quoted `--props` JSON broke (3 of 18 steps
  failed on it). The skill and the itinerary use it for props with words in them.
- **Replies in plain words.** The reply rules leave out lookup services, commands and exit codes ("Overpass place
  search was unavailable"), say what was busy plainly, and name sources by who publishes the data.

## 0.1.5 (2026-10-28)

Fixes to 0.1.4.

- **Not a hotel named after the place.** `add-point`'s preference for a candidate whose own name is the query's (0.1.4)
  ignored generic words on the candidate's side too, so "Hôtel du Sacré-Cœur" or "Café Sacré-Cœur" counted as
  "every word of the query and no other" and replaced "Basilique du Sacré-Cœur", the landmark the search listed first.
  A generic word still never makes a name match, but a candidate's generic word the query does not have is a word
  more: only the place itself, or a name with every word of the query and none it lacks, replaces the search's pick.
- **Each leg at its place in the order.** A trip that goes the same way twice ("Lisbon → Porto → Lisbon → Porto")
  took the first Lisbon → Porto leg for both travel days since 0.1.4. A travel day now takes the leg at its place in
  the order between its two stops first (also when the list names a stop twice in a row), then any leg between them.
- **Every place that fits no day is named.** `not_on_plan` and "Not on any day" listed only places with a `"stop"`;
  a place without one goes to the nearest stop, and now it is named too when it fits no day there.

## 0.1.4 (2026-10-28)

Fixes from the 27 Oct 2026 live test ("Plan 3 days in Lisbon").

- **Days in one place.** `uw plan` takes one stop: "3 days in Lisbon" is `--ids lisbon --nights 3`, a stay whose days
  are loops from the same base, with no travel day. It refused one stop ("a trip plan needs at least two stops"), so
  the agent named the city twice and got "Lisbon → Lisbon … Travel day". A stop named twice in a row is now one stay
  (its nights add up), and one stop with 0 nights is a single day. `reference/itinerary.md` gains "One base": the
  city as the stop, stays in the area recommended (`uw stay --near <lng,lat> --near-label "<area>" --stop <city>`),
  places by area, the plan. A stay near a district walks "to <district>", not "to the station".
- **A day's places lie together.** `uw plan` groups a stop's places by area: the closest share a day (no day spans two
  areas when another split exists, and places in one area are shared evenly), each day in walking order from the
  base, the area nearest the base first; the trip's first day takes an area too when the full days would hold more
  than 2 places each. Places were spread over the days by
  count, which put Jardim da Estrela on the Alfama day. `uw plan` and `uw validate` warn when a day has a place far
  from its other places or nearer another day's, and name the day it belongs to ("… is 2.2 km from that day's other
  places but 0.1 km from "Basílica da Estrela" on Fri 30 Oct"); a day trip far out of town is judged on its own. The
  thresholds are data: `scripts/plan-checks.json`. Places that fit no day (over `--per-day`) are named in the output
  (`not_on_plan`) instead of being dropped quietly. A travel day takes the leg between its two stops before the leg at
  its place in the order.
- **The place, not a place named after it.** `add-point` takes a candidate whose own name is the query's name (or
  every word of it and no other) over one that only contains it, whatever order the search gave: "Padrão dos
  Descobrimentos" is the monument, not "Miradouro do Padrão dos Descobrimentos". A station or stop is never preferred
  this way unless the query asks for a kind of transit (the zoo, not the metro station named after it; "… Airport"
  still gets the airport).
- **The departure day says what it is.** The day after the last night carries `"depart": true` and "Leave <stop>.";
  nothing is planned on it, its row says "Departure" instead of looking like an empty day, and the page's "Trip · N
  days" does not count it ("3 days in Lisbon" reads "Trip · 3 days").
- **A preview the space can start again.** `uw host --detach` (and `uw serve --detach`) prints the one command that
  starts the same server in the foreground (with the site's absolute path, so it runs from wherever the card was
  opened) and the `instafy preview open … --serve-cmd "…"` line, and `SKILL.md`
  step 9 runs that line, so a stopped or sleeping map comes back from its card on any platform. A server keeps its own
  record while it runs, and one of the same folder that answers on the port is reused, so a server the space started
  again is found by the next `--detach`, `--stop` and `uw reload` instead of a "port in use".
- **No `.uwcache/` in the space's files.** In an Instafy space (`INSTAFY_CACHE_DIR` set) a site's working state (its
  server's record and log, the write lock, the turn clock) and the background jobs a folder starts live in
  `INSTAFY_CACHE_DIR/interactive-map/state/`, and responses only in the space's shared answers; jobs used to write a
  `.uwcache/` at the workspace root. Adapter datasets (`uw adapter`, handlers) use the same shared cache
  (`UW_CACHE`, else `INSTAFY_CACHE_DIR`, else `~/.cache/uw`), so a hosted turn no longer downloads them again. Outside a
  space nothing changes.

## 0.1.3 (2026-10-27)

- **`uw` is a command.** `.instafy-pack.json` declares `"bin": {"uw": "scripts/uw.mjs"}`, so a runtime that knows
  `bin` puts `uw` on PATH in every shell. `SKILL.md`, `reference/recipes.md`, the README and `uw help` say to run
  `uw <command>` and no longer define a `uw()` shell function, which the agent wrote again before every command
  because each command runs in a fresh shell. Where a shell does not find `uw`, `SKILL.md` says to run
  `node <this skill's folder>/scripts/uw.mjs`; `entry` stays, so older runtimes keep their launcher.
- **Activity labels.** The manifest's `activity` table gives each `uw` subcommand a short, fixed label for a chat's
  activity line: "Looking up places" while `add-point` runs, then "looked up 14 places"; `validate` that exits 0 is
  "built the map"; setup steps (`new`, `fit`, `serve` …) are quiet. Labels are plain words only a count fills in,
  checked by `scripts/pack-commands.mjs` (`node scripts/manifest.mjs --check`), never text from a command's output.
- **The page says what it is.** The engine sets `<meta name="description">` from numbers and fixed words only:
  "Trip · 3 days · 14 places", or "Map · 14 places" (context dots are not counted). A link preview, such as
  Instafy's preview card, shows it; the title and place names never go in it. `uw upgrade <site>` brings it to an
  existing site.
- `SKILL.md`: after a later change and `uw reload`, run step 9's `instafy preview check` (it refreshes the preview
  card's picture where Instafy supports it).

## 0.1.2 (2026-10-26)

- **Empty answers ask the next provider.** An empty answer from the place search moves on down the `geocode` chain
  (Wikipedia's coordinates, then the OpenStreetMap name search), so a small venue the first search lacks can still be
  found. `lookup-providers.json` gains `chain_rules`: `places` keeps `on_empty: "stop"`, because an empty Overpass
  answer is authoritative there. `not_found` now means a complete provider answered empty and no provider failed;
  nothing found while one could not answer is `unavailable`.
- **Partial results say so.** An answer from a fallback provider is `"status": "partial"`, with `via`, `data_reason`
  and `data_missing`; `geocode` and `add-point` print `PARTIAL: … — data may be incomplete` and the point carries
  `data_status: "partial"`; so does a `station` a fallback found. The map's card for such a point says "data may be
  incomplete" and its layer "partial data". `enrich --route-to` that routed only some options marks those walk times partial, so the
  verdict never calls one the shortest or longest. `overpassBatch` reports a batch that was not answered.
- **Time budget.** No command runs longer than 540 s: `--timeout 0` is that ceiling, not "no limit". `handoff
  --apply` has 420 s for the whole run, and the steps it starts inherit the deadline through
  `INSTAFY_JOB_DEADLINE`. Without a host clock, the pack's own turn clock caps an explicit `--timeout` and `handoff
  --apply` too: a command late in the turn gets only what is left before the turn's hard limit. A lookup chain keeps time back for its fallbacks, and one Overpass call takes at most 90 s
  across every mirror.
- **Polite to public services.** An HTTP 429 is never retried. That service, or that Overpass mirror, is not asked
  again by any command that turn, and not before its Retry-After. The User-Agent names a contact URL, and
  `INSTAFY_LOOKUP_CONTACT` adds the operator's. Providers declare `cache.ttl_s` from their caching terms. Photon's
  bias point is rounded to about 100 m, so nearby searches share a cached answer.
- **State that outlasts the turn.** Lookup health, rate-limit holds, slots, the Overpass lock and the shared answers
  live in `INSTAFY_CACHE_DIR`, the runtime's per-space folder, when it is set. Where the state folder cannot be
  written (no `INSTAFY_CACHE_DIR`, a read-only HOME), the slot locks fall back to the temporary folder, so the limit
  on concurrent requests to a service still holds. `.instafy-pack.json` declares the
  settings the pack reads (`"env": ["UW_*", "INSTAFY_LOOKUP_*"]`), so a runtime can pass them to the pack's processes.
- `SKILL.md` and `reference/data-sources.md`: facts come from pages the agent reads (`instafy web read` and the
  `instafy-web-research` skill, else `uw cite`). The map lookups only place pins, routes and areas, and a sign-in,
  CAPTCHA or 429 is final for the turn.

## 0.1.1 (2026-10-26)

- `SKILL.md`, `reference/itinerary.md` and `uw handoff --help` source facts with the pack's own `uw cite`; they
  named an Instafy command that released Instafy does not have.

## 0.1.0 (2026-10-26)

First public release of the interactive-map skill pack, moved out of the Instafy runtime into its own repository.

- `skills/interactive-map/`: `SKILL.md`, references, the `uw` CLI (no dependencies, Node 22 or later) and the
  starter site with the map engine and MapLibre GL JS 5.24.0.
- Commands for places, lines, routes, walk areas, trip legs and day plans, lodging near a station, air quality,
  calm-vs-lively estimates, named areas, doorstep street photos, Wikipedia, dataset adapters, the question/verdict
  block, a dev server, an agent host for bound sites, snapshots and validation.
- Pack manifest schema 1 (`engines.node`, `tree_sha256`), generated by `scripts/manifest.mjs`.
- Licence AGPL-3.0-only, with third-party notices for vendored code, the basemap style and data credits. Sites
  built from the starter carry `engine/LICENSE`, `engine/THIRD_PARTY_NOTICES.md` and `STYLE-LICENSE.md`.
- Release asset: a reproducible tarball of `skills/interactive-map/` plus its sha256.
