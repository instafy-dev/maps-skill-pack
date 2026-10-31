# maps-skill-pack: interactive map sites from a sentence

An agent skill pack for [Instafy](https://github.com/instafy-dev/instafy) and any agent that reads `SKILL.md` files.
The agent reads `skills/interactive-map/SKILL.md` and runs a small Node CLI (`uw`, no dependencies) to fetch real
data: OpenStreetMap places and lines, walking routes and 10-minute walk areas, a calm-vs-lively estimate, street
photos, official registers, air quality and Wikipedia. It writes one `map.config.json` and hands back a static map
site that answers a question on a phone. Lettered options A/B/C, a verdict strip, named areas, why-cards that give
the basis of every number, dated doorstep photos and links out to Street View and Apple Maps.

The site is plain files the person owns, so "make all railways green" or "add gyms" is a small edit, not a rebuild.
A site can also be **two-way bound to an agent**. Buttons on the map send typed intents, an agent or a local handler
does the work, and the results come back as records with provenance, live, to everyone viewing.

## How Instafy installs it

Instafy installs this pack in every space by default (this is rolling out with the runtime release that pins this
repository; until then, import it by hand as below). The runtime image and the desktop app carry a pinned release
of `skills/interactive-map/` (a tagged tarball checked against its sha256 and the manifest's `tree_sha256`). On each
turn the runtime writes the managed `SKILL.md` and a small `uw.mjs` launcher into the space at
`.agents/skills/interactive-map/`, keeps them out of the space's git history, and only does so when a Node that meets
the manifest's `engines.node` is available. The manifest's `bin` puts the `uw` command on PATH in every shell, so the
agent reads `SKILL.md` and runs `uw <command>`. Its `activity` table gives each `uw` command a short, fixed label
("Looking up places", "looked up 14 places") that Instafy can show while the agent works.

## Import it by hand

To add a pinned copy to a space yourself (or to try a newer tag), import the skill folder:

```
/skills import https://github.com/instafy-dev/maps-skill-pack/tree/v0.1.19/skills/interactive-map
```

This copies the folder into the space (`/skills import` takes up to 256 files and 8 MB; the pack is about 109 files
and 3 MB). Any other agent that reads `SKILL.md` files can use the folder the same way: copy
`skills/interactive-map/` into its skills directory.

Then ask for a map: "where should I stay in Lisbon for quiet nights near the metro?", "a 10-day rail trip round
Taiwan", "cafés within a 10-minute walk of my hotel".

## Use it by hand

Node 22 or later. Nothing to install.

```sh
export PATH="$PWD/skills/interactive-map/scripts:$PATH"   # its `uw` shim runs scripts/uw.mjs (zsh and bash)
uw doctor                                              # Node, network services, Playwright
uw geocode "Amsterdam"                                 # pick a centre from the output
uw new my-map --title "Amsterdam cafés" --center 4.8897,52.3740 --zoom 13
uw add-point my-map --layer stay --query "Hotel V Nesplein" --near 4.8897,52.3740 --id hotel-v
uw places my-map --layer cafes --kinds coffee --around stay --radius 1200
uw isochrone my-map --layer walk --from layer:stay --minutes 10
uw enrich my-map --layer stay --count cafes
uw fit my-map
# paste the printed "Add: {…}" snippets into map.config.json "layers", then:
uw validate my-map --signal && uw snapshot my-map --signal && uw serve my-map --host 0.0.0.0
```

`uw serve` prints a localhost address and, with `--host 0.0.0.0`, a LAN address to open on a phone on the same
Wi-Fi. `uw host <site>` is `serve` plus the agent loop for the intents in the site's `bound.json`. With `--detach`
both run in the background and print the command that starts the same server in the foreground. In Instafy a map is
not detached: one `instafy preview open --title "<title>" --serve-cmd "uw host . --port {port}" --start --json`, from
the site's folder, picks its port, serves it and shows its preview card, which the space can start again after the
server stops.

### Commands

| Group | Commands |
|---|---|
| Site | `new`, `doctor`, `validate`, `fit`, `set`, `upgrade`, `serve`, `host`, `reload`, `snapshot`, `wait` |
| Places and lines | `geocode`, `add-point`, `places`, `lines`, `station`, `wiki` |
| Getting around | `route`, `isochrone`, `legs`, `transit`, `plan`, `handoff` |
| Choosing | `stay`, `enrich`, `feel`, `areas`, `question`, `air` |
| At the door | `doorstep`, `photos` |
| Data | `adapter` (dataset adapters with licences), `cite` (one public page as a fact source), `lookups` (services and their health) |

A trip, in one place or several, follows `skills/interactive-map/reference/itinerary.md`. Run `uw help` for all commands and
`uw <command> --help` for flags. The config reference is `skills/interactive-map/reference/config.md`, and how-tos
are in `reference/recipes.md`.

## Settings

| Variable | What it does |
|---|---|
| `UW_OVERPASS`, `UW_PHOTON`, `UW_OSRM`, `UW_VALHALLA`, `UW_OPENMETEO`, `UW_WIKIPEDIA`, `UW_PANORAMAX`, `UW_TRANSIT_URL`, `UW_BASEMAP_TILES` | Point a data source at another instance (a self-hosted server or a gateway) |
| `UW_CACHE`, `UW_NO_CACHE` | Cache folder for fetched data, or turn the cache off |
| `INSTAFY_CACHE_DIR` | A folder that outlasts the turn, set by the Instafy runtime per space: lookup health, rate-limit holds, slots, shared answers, downloaded datasets, each site's working state (server record and log, write lock, turn clock) and background jobs live there, so no `.uwcache/` lands in the space's files (a hosted tool turn's HOME is new every turn) |
| `INSTAFY_LOOKUP_PROVIDERS`, `INSTAFY_LOOKUP_STATE`, `INSTAFY_LOOKUP_CACHE_DIR` | Add or replace lookup providers and chains (JSON or a file), and where lookup state is kept |
| `INSTAFY_LOOKUP_CONTACT` | The operator's contact (a URL or e-mail) added to the User-Agent every request carries |
| `UW_MAX_COMMAND_S`, `UW_APPLY_BUDGET_S` | Lower the ceiling of one command (540 s) or of a whole `handoff --apply` run (420 s); never raise them |
| `UW_PLAYWRIGHT`, `UW_BROWSER_CHANNEL` | Playwright module path and browser channel for `uw snapshot` |
| `UW_PUBLIC_URL` | Extra host names `uw serve` / `uw host` answer for (e.g. a tunnel) |
| `UW_DEBUG` | Verbose errors |

## Data sources

By default the pack uses free community services with no keys: OpenFreeMap tiles, Overpass and Photon (OpenStreetMap),
FOSSGIS OSRM and Valhalla, Open-Meteo, Wikipedia and Panoramax. They are fine for prototypes and personal maps, not for
platform-scale traffic. `DATA-SOURCES.md` has the licences, limits and a production path for each, and
`THIRD_PARTY_NOTICES.md` lists the credits a map must keep.

## Limitations

- The default services are free community servers with fair-use limits. Heavy use gets slow answers or refusals;
  the CLI then skips that step and says so, and a service that answers 429 is not asked again that turn. They are
  light helpers for pins, routes and tiles; facts come from the pages the agent reads (`instafy web read`, `uw cite`).
  For real traffic, point the `UW_*` variables at your own instances.
- An answer from a fallback source (the first search was down or found nothing) is labelled `partial` ("data may be
  incomplete"), and verdicts made from incomplete data never say shortest or longest.
- Coverage follows OpenStreetMap. Places, opening hours and lines can be missing or out of date, and the
  calm-vs-lively estimate is a heuristic from mapped features, not a measurement.
- Official register adapters exist only for some datasets (`uw adapter list`); elsewhere lodging comes from OSM.
- `uw transit` needs a MOTIS planner (`UW_TRANSIT_URL`); without one, ride times are estimates and are marked so.
- `uw snapshot` and the `*-browser` tests need Playwright (`UW_PLAYWRIGHT`); everything else is plain Node 22.
- Some commands the skill mentions, such as `instafy web cite` and the research-team handoff flow, need a newer
  Instafy runtime than the current public release; the pack falls back to its own `uw cite` and plain steps.
- The test fixtures use public open data, including real, licensed businesses in Taipei; no endorsement is implied.

## Releases

Each tag `vX.Y.Z` has a GitHub release with `interactive-map-vX.Y.Z.tar.gz` (a `git archive` of
`skills/interactive-map/` at the tag, entries under `skills/interactive-map/`, the commit id in the pax header) and
its `.sha256`. `node scripts/release-tarball.mjs vX.Y.Z` rebuilds it and checks the archived content against the
manifest's `tree_sha256`. `node scripts/manifest.mjs` regenerates the manifest after any change to the pack; CI
fails when it is stale. See `CHANGELOG.md`.

## Repository layout

```
LICENSE                 AGPL-3.0
THIRD_PARTY_NOTICES.md  vendored code, runtime data credits, test data
DATA-SOURCES.md         licences, limits and the production path for every data source
ENGINE-SPEC.md          v0 build contract between engine, scripts and skill
ENGINE-SPEC-v0.2.md     v0.2: question, verdict, tiers, areas, photos, adapters, binding, uw host, --signal
tests/                  node --test tests (the *-browser tests need UW_PLAYWRIGHT)
scripts/                manifest.mjs, check-syntax.mjs, release-tarball.mjs
CHANGELOG.md
skills/interactive-map/ the pack root: what Instafy installs and what /skills import copies
  SKILL.md              procedure and hard rules for the agent
  .instafy-pack.json    pack manifest
  LICENSE, THIRD_PARTY_NOTICES.md
  reference/            config.md, recipes.md, itinerary.md, data-sources.md, regions/
  scripts/uw.mjs        CLI entry (scripts/uw is a shell shim); scripts/lib/*.mjs, one file per command group
  scripts/adapters/     dataset adapters
  scripts/handlers/     intent handlers run by `uw host`
  scripts/schemas/      records, bound and messages JSON schemas
  starter/              copied by `uw new`: index.html, map.config.json, style.json (+ STYLE-LICENSE.md), custom.js,
                        engine/ (kit-owned, with LICENSE and THIRD_PARTY_NOTICES.md) and engine/vendor/
                        (MapLibre GL JS 5.24.0, BSD-3-Clause)
```

Run the checks with `node scripts/check-syntax.mjs && node scripts/manifest.mjs --check` and the tests with
`node --test tests/*.test.mjs`.

## Licence

AGPL-3.0-only, the same as Instafy. Vendored third-party code keeps its own licence (see `THIRD_PARTY_NOTICES.md`).
Sites built from `starter/` contain the AGPL engine code: keep `engine/LICENSE`, `engine/THIRD_PARTY_NOTICES.md` and
`STYLE-LICENSE.md` with them, and keep the map's credit line.
