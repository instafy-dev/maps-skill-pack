# Changelog

All notable changes to this pack. Versions follow [semantic versioning](https://semver.org/); the release tag is
`v<version>` and `skills/interactive-map/.instafy-pack.json` carries the same version.

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
  thresholds are data: `scripts/plan-checks.json`.
- **The place, not a place named after it.** `add-point` takes a candidate whose own name is the query's name (or
  every word of it and no other) over one that only contains it, whatever order the search gave: "Padrão dos
  Descobrimentos" is the monument, not "Miradouro do Padrão dos Descobrimentos". A station or stop is never preferred
  this way unless the query asks for one (the zoo, not the metro station named after it).
- **The departure day says what it is.** The day after the last night carries `"depart": true` and "Leave <stop>.";
  nothing is planned on it, its row says "Departure" instead of looking like an empty day, and the page's "Trip · N
  days" does not count it ("3 days in Lisbon" reads "Trip · 3 days").
- **A preview the space can start again.** `uw host --detach` (and `uw serve --detach`) prints the one command that
  starts the same server in the foreground and the `instafy preview open … --serve-cmd "…"` line, and `SKILL.md`
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
