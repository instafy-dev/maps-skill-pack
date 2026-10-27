# Changelog

All notable changes to this pack. Versions follow [semantic versioning](https://semver.org/); the release tag is
`v<version>` and `skills/interactive-map/.instafy-pack.json` carries the same version.

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
