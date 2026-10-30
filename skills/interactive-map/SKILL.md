---
name: interactive-map
description: REQUIRED for any request that involves a map (choosing hotels or areas, places nearby, walks, routes, trips, recolouring map features). Before writing anything, read .agents/skills/interactive-map/SKILL.md in full and build with its uw commands (uw new <dir> ...). Never hand-write map HTML or embed a Google Maps iframe; never type coordinates yourself.
routing_keywords: [map, maps, walk, walking, walkable, neighbourhood, neighbourhoods, neighborhood, neighborhoods, district, area, hotel, hotels, hostel, apartment, apartments, airbnb, stay, where to stay, closest, nearest, distance, commute, route, road trip, trip, travel, itinerary, day trip, food spots, places, nearby, cafes, coffee, restaurants, gym, gyms, office, beach, bike, cycling, noisy, noise, quiet, railways, pins, layers, visualise, visualize, air quality, street view, licence, karta, kartan, hotell, hotellen, boende, promenad, närmast, resa, område, stadsdel, kvarter, bo, lugna, nätter, mapa, 地図, マップ]
context_parent: instafy-skill-router
---

# Interactive map sites

A site is a folder: `index.html`, `map.config.json` (content), `style.json`, `custom.js`, `data/` (written by
commands), `bound.json` (optional: buttons that ask an agent), `engine/` (kit-owned, never edit).

Run `uw <command>`: it is on PATH in every shell (on `uw: not found`, run `node <this skill's folder>/scripts/uw.mjs`).
Every command has `--help` and `--json`. Exit 0 ok, 1 error, 2 not found / needs your decision, 3 snapshot skipped,
**4 unavailable** (a service busy, slow or down; not a wrong name: the map is valid; go on).

## Hard rules

1. Never type coordinates or invent places. Points, lines and areas come from commands; `--near`/`--center` from `geocode`.
2. Check what `add-point` chose. On exit 2 retry once (better `--query`, `--pick N`, `--osm <id>`). Still not found:
   keep going; the map shows it as "Not found yet". Never stop early or leave an empty map.
3. Never write verdict, why or area text by hand without `cites`; every number comes from a metric or record.
   Estimates say "est.". Never call a place unsafe, dirty, illegal or unlicensed (a miss is "not found").
4. Keep credits (`attribution`, photo and open-data credits).
5. Edit `map.config.json`, `style.json`, `custom.js`, `bound.json`; never `engine/` or `"uw"` blocks. Fix a feature
   with `uw set <site> <layer>:<id> …`. Props with words go on stdin (`--props-file - <<'JSON'`, the object, then
   `JSON`): an apostrophe breaks single-quoted JSON.
6. Facts come from pages you read (`instafy web read <url>`, skill `instafy-web-research`; else `uw cite <url>
   --grep <what>`); unsourced = unverified. `uw` only places pins, routes: one network command at a time, small
   areas; no Google APIs, Nominatim, scraping. Sign-in, CAPTCHA, 429: stop.
7. Never type a price or licence number. Never present a filed rate as a price, permitted hours as opening hours,
   or one register's answer as all.
8. Each item the request names is on the map, or the reply names it as missing: `uw new … --expect "A,B:2"` makes
   `uw validate` fail while one is missing.

## Procedure: fast first

Hosted turns stop at 10 min: card + map + verdict early, reply with time to spare.
`uw question` and `uw validate` print the time used and left; under ~3 min left: start nothing slow, reply.
Long commands: `--detach`, then `uw wait` (exit 75: again).

**Trip** (days or nights somewhere: "3 days in Lisbon", "what to see each day"): `reference/itinerary.md`, not steps
4-8 ("One base" for one place): a Plan tab, days by area, real stays; never days in place notes.

**Phase A: a useful map (≤ 4 min)**
1. Plan (no tools, never ask: fill gaps for the `Assumed:` line): `kind` (choose-one | find-place |
   find-area | plan-route | explore), `ask` (≤ 70 chars), 2-5 options (pins A-E), ≤ 4 criteria with weights 0-3
   (quiet, MRT walk, cafés…), lenses (sleep, night, move, morning).
   Write title, ask and notes in the user's language; Swedish: `--lang sv` in step 3.
2. `uw geocode "<district, city>"` → `lng,lat`. Exit 4: go on without `--center`/`--near`.
3. `uw new <site> --title "…" --ask "<ask>" --center <lng,lat> --zoom 13`, then its card at once, before any lookup
   (a slow one costs content, never the card), from the site's folder: `instafy preview open --title "<title>"
   --serve-cmd "uw host . --port {port}" --start --json`. It picks the port, starts the map (outlives the turn; runs
   bound.json buttons) and posts the card; the card can restart it. Exit 2 names a log: read it, fix, rerun.
   Never post a URL (not even localhost). Without `instafy`: `uw host <site> --detach`.
4. `uw add-point <site> --layer hotels --query "<name>, <city>" --near <lng,lat> --id <slug>` per option. Keep each
   `Tell the user` line. Address sent later: `--query "延平北路三段 4號" --name "<name>" --kind hotel`.
5. Places for the 1-2 things asked most, small radius:
   `uw places <site> --layer mrt --kinds mrt_station --around hotels --radius 800`, same with `--layer cafes --kinds cafe`.
6. `uw enrich <site> --layer hotels --route-to mrt --nearest mrt --count cafes`.
   They ask about licences: where a lodging register covers the area (`uw adapter list --at <lng,lat>`), run it
   with `--layer hotels --records` (licence chip).
7. `uw question <site> --kind choose-one --options hotels --criteria calm_night:3,walk_min_mrt:2,cafes:1,calm_night_area:0
   --lenses sleep,night,move --lens sleep --force`. Sleep = the door (`calm_night`, or `noise_night_db` when
   measured; added if left out); the walk area (`calm_night_area`) is context. List everything you want: unmeasured
   criteria/lenses are "pending" and join on re-run. Letters follow the rank (A = best); the verdict is generated.
   "NOTHING MEASURED YET SEPARATES": say "too close to call so far"; run the step it names.
8. `uw fit <site>`, then `uw validate <site> --signal`; fix every error.
9. `uw reload <site>` (open viewers update), then `instafy preview check --port <port>` (the JSON's `port`;
   refreshes the card's picture): fix every error it lists; open the PNGs it names. Public link only on request
   (`instafy-frontend-previews`).

**Phase B: refine (in order, one at a time, while the time printed by question/validate allows)**
After each: re-run the step-7 command and `uw validate <site> --signal`. Exit 4: note it for Phase C.
- First, each layer printed PARTIAL (verdict note "MRT data partial"): run the re-fetch it names, then step 6.
  Never call an option shortest/longest on partial data.
- `uw snapshot <site> --signal` (~45 s; exit 3 = no browser, fine): fix failed rules; look at `snapshots/*.png`.
- Region extras: `reference/regions/<country>.md`.
- Calm/lively, day and night (Overpass, 1-3 min):
  `uw isochrone <site> --layer walk --from layer:hotels --minutes 10`, `uw feel <site> --around hotels`,
  `uw enrich <site> --layer hotels --feel --feel-within walk`,
  `uw areas <site> --lens quiet_night,lively_night --within walk --options hotels`.
- `uw doorstep <site> --layer hotels` (faces the door), `uw photos <site> --layer hotels` (30-60 s).
- Also `lines`, `route`, `legs`, `wiki`, `air` when they help.

**Phase C: reply** in 3-6 lines, even if your host asks for one sentence (this is it). No paths, "validates",
commands, services or exit codes (Overpass, Photon, OSRM, "exit 4"): say it plainly ("the place search was busy");
sources by publisher (OpenStreetMap, Wikipedia) in one line; say what is unverified. Start with the
verdict as `uw question` printed it (the pick and why, by name, no map letter; then the persona line),
the `Assumed:` line, what is estimated or partial (PARTIAL: "may be incomplete"), every `Tell the user` line
(a register match: name the listing, never ask to confirm), anything "Not found yet" (what was searched; they can
send its address). End with a ```suggestions block, a chip per line: skipped or
unavailable steps ("Try the café search again", "Add the calm/lively layer").

## Config and later changes

- **The message names an open surface** (the prompt's "Open surface" block): edit that site in place (never a new
  site or card), `uw validate <site>`, then step 9 with `uw reload <site> --note "<what changed>"`. Same after any
  later change to a site someone may have open. Trips: `reference/itinerary.md` "Later changes to a trip".
- With a question, other layers become dots. If S1/S2 fail, give the busiest layer `"tier": "context"`.
- Do things (only if planned): `bound.json` intents + `"bind": true`; handlers `pack:check_registry`,
  `pack:find_hotels_nearby` or your own `handlers/<name>.mjs` (recipe 27).
- No map (a plan or list): `instafy bind init sites/<slug> --starter timeline|ranked`.
- Restyle only if asked: `basemap.overrides` / `layers[].style`. Commands never overwrite another's file: new `--layer` or
  `--append`. Re-run `enrich`, `areas`, `question` when inputs change. `uw upgrade <site>` refreshes `engine/`.

## When things fail

- "outside", "mismatch", "far": a wrong match; fix the query.
- Exit 4: go on; retry a named item once, as printed.

## Reference

`reference/config.md` (every key), `reference/recipes.md` (recipe 0 = a full example), `reference/data-sources.md`
(limits, credits).
First use: `uw doctor`.
