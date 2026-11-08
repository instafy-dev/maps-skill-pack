# Trips: stops, stations, stays, trains, days

On a turn that plans a research team (its skill is loaded and the trip meets its threshold), do not build: emit
the plan; the builder lane follows this file later.

Use this for an itinerary: two or more places with nights ("3 nights Taipei, then Hualien…", "10 days in Japan with
hotels and trains", "a rail loop with places to stay"), or days in one place ("3 days in Lisbon": "One base", right
after step 1). It replaces steps 4-8 of SKILL.md; the hard rules, the
card (step 3), step 9 and the turn clock stay. It works anywhere: where an open-data adapter covers the area (`uw adapter list
--at <lng,lat>`, e.g. a national lodging register) its data comes first; elsewhere OpenStreetMap. Region extras: when
`reference/regions/<country>.md` exists (e.g. `taiwan.md`), read it too.

The traveller wants five things answered: where they sleep each night (and why there), how they get from one place to
the next (and how long that takes, if anyone can say), what each day is for, what is unverified, and one map to check
it all on. Build that, in this order.

## Phase A: the trip on a map (≤ 4 min)

**0. Parse, don't ask.** Never stop to ask, even on a vague ask ("two weeks in <country>"): build. List the stops
in travel order with nights each, the start date and who travels. Keep everything the user fixed; fill only the
gaps, with these defaults: 2 adults, mid-range hotels, a balanced pace, the length they gave (none: 7 nights), a
start date inside the window they named, stops you choose for the season. State every filled gap in ONE line for the
reply, e.g. `Assumed: 2 adults, mid-range, arrive Fri 7 May, Porto 3 nights then Lisbon 4 (7 nights), flying home
from Lisbon.` Split free nights by what each
stop offers (a big city with day trips gets more than a pass-through town), not by a fixed pattern. Stays are hotels
unless the user asks for hostels or says the budget is tight (an unknown party counts as hotels). A loop
names its first stop again at the end. Nights must add up to the trip length; dates come from `uw plan`, never typed
by hand. The trip ends where the traveller flies home: a loop names its first stop again; a one-way route ends at
a city with an international airport (or its last leg goes back to one), and the `Assumed:` line says where they fly
out ("flying home from Taipei"), so the last day never strands them.

**1. Site.** `uw geocode "<country or first city>"`, then
`uw new sites/<slug> --title "<Country> by train" --subtitle "7–14 May · 7 nights" --ask "<the question in your words, ≤ 60 characters>" --center <lng,lat> --zoom 7 --expect "<Stop>:<nights>,…"`
(its folder under `sites/`, as every page's, is `<site>` below; the ask is the map's heading, e.g. "Two weeks in
Taiwan by train": never the user's message pasted in; `--expect` is the route from step 0: every stop the user
named or you chose, so `uw validate` fails while one is missing).
Then its card at once (SKILL.md step 3), before any lookup: a slow lookup can cost the map content, never its card.
Next, two or more places: steps 2-6 in `reference/several-stops.md` (read it whole), then Phase B here. One place:
"One base", next.

## One base: days in one place

"3 days in Lisbon", "a weekend in Kyoto", "a day in Porto": one stop and no trains. Step 0 (parse, defaults, the
`Assumed:` line), step 1, Phase B (next) and step 6 (`uw validate <site> --signal`, then SKILL.md step 9) stay;
instead of steps 2-5:

1. **The stop** is the city, never the hotel (`uw plan` refuses a place to stay as a stop): `uw add-point <site>
   --layer stops --query "<City>" --country "<Country>" --kind city --id <slug> --props '{"nights":N}'`. "N days" is
   N nights unless the user gave dates; one day is 0. The plan has a dated day per night and no departure day: they
   leave the day after, which the stay line's dates end on.
2. **Stays** in the area you recommend staying in (a page you read says why): `uw geocode "<area>, <City>"`, then
   `uw stay <site> --near <its lng,lat> --near-label "<area>" --stop <slug>` (`--kinds hotel` unless the person asked
   for hostels or said the budget is tight; a reason each). The base is the rank-1 stay; each day starts and ends
   there. Never the area itself as a hotel. No stay found (exit 2 after widening, or exit 4): pin the area as the
   recommendation, labelled as one:
   `uw add-point <site> --layer stays --query "<area>, <City>" --kind area --id <area slug> --props-file - <<'JSON'`, then
   `{"stop":"<slug>","note":"Area to stay in: <why, from the page>","source_url":"<that page>","source":"<site>"}` and
   `JSON` on their own lines (the days start there; no page says why: no note), and the reply says what `uw stay`
   said: none found near it (exit 2), or places to stay not looked up yet (exit 4). `uw validate` fails while a stop's
   only stay is an area and `uw stay` has not looked there (widened to 3000 m when it found none), or while an area's
   note cites no page `uw cite` read.
3. **Places by area**, before the plan: per day an area worth the day (a neighbourhood, a district a ride away, a day
   trip), 2-3 sourced places in it (Phase B step 1, with `"stop":"<slug>"`). Never put a place on a day because a
   list had room. Every full day gets its places before the plan: `uw plan` refuses one with fewer than two.
4. **Plan**: `uw plan <site> --stops stops --ids <slug> --nights N --start <date> --stays stays --sights sights,food,daytrips`.
   Every day is a loop from the base: a stop's places are grouped by area (the closest share a day, in walking
   order, the area nearest the base first; every day, the arrival day too, gets a place before any gets a second).
   Never "<city> → <city>": a stop named twice in a row is one stay. The reply ("Reply", at the end): the stay with
   its dates as `uw plan` prints it, the `Assumed:` line (the dates too, when the person gave none), where to stay and
   why, then each day's area.

**Days that hang together.** `uw plan` and `uw validate` warn when a day has a place far from its other places, or
nearer another day's (`day places: "<place>" (<day>) is 3.1 km from that day's other places but 0.2 km from
"<place>" on <day>`). Move it to the day named, in the items and both days' texts, or rebuild with `uw plan … --force`
(it groups by area). A day trip far out of town is judged on its own.

## Phase B: make it worth following (one step at a time, while the turn clock shows more than ~3 min left)

A plan whose full days say only "Day in …" is not finished. When the ask is what to see or do each day (a trip of
days: "3 days in Lisbon", "what to see each day"), build the plan with `--sights`: `uw plan` refuses fewer than two
a day while there is time, and `uw validate` fails while a full day has fewer than two sourced places (one: in the turn
that planned the days, while its clock shows more than ~3 min left; a later turn keeps the days the person changed),
as it fails for a stop asked for that is not on the map.
One place a day only when the person asked for it: `uw plan … --per-day 1`. Without `--sights` it warns when most
full days are empty, and the turn clock prints how many are empty or thin. While any is and time is left, add sights
rather than reply. Sights come from `uw cite` in this turn, never from a browser card. Step 1 comes first.

1. **Sights with sources, 2-3 a full day.** A city's page (its Wikivoyage See/Do, the official tourism site) only
   says which places are worth it; it is never a place's source. Each place's source is the venue's own site, the one
   you cite: `uw cite <its own site> --grep "<its name>"`. That is the attraction's, park's or operator's official site
   (skill `instafy-web-research` ranks sources so, in its "Sources by need"): one you know, or the one `instafy web
   search "<its name>" --chain reference-search --json` lists. Its Wikipedia article only where the turn found no such
   site that names it and can be read. Checked for being current (closures, renovations, seasonal
   hours); that page is its `source_url`, read in this turn (`uw validate` fails while places share one, or while one
   cites a page `uw cite` did not read or that does not name it; `uw add-point` and `uw set` refuse a `source_url` no
   `uw cite` read ("cite it first"), and say at once when a page `uw cite` read does not name the place; an image is
   no page). A refused site (it bans agents, robots.txt, a bot
   check) is a plain link, never fetched another way. At most about 2 pages a sight. One place, one pin: a day short of
   places takes another place (`uw add-point` refuses one already pinned, naming its pin). Then each sight in a command
   of its own, one `uw add-point` per command (chained, one slow lookup held back the sights after it and the plan):
   ```
   uw add-point <site> --layer sights --query "<local-language name>" --country "<Country>" --strict-name --near <that station's lng,lat> --id <slug> --props-file - <<'JSON'
   {"stop":"<station id>","source_url":"<its own site's page>","source":"<site name>","why":"<what the page says to do there>"}
   JSON
   ```
   (props with words in them always go on stdin like this: an apostrophe in single-quoted JSON breaks the command;
   exit 2 = no hit carries the name: retry once with the local name, else list it as unverified; exit 2 "already
   pinned" = it is on the map: never pin it again, the day takes another place; food spots go on `--layer food`, day
   trips on `--layer daytrips --max-km 80`).
   Once each has finished (an exit code, not still running: wait on one that is, never start it again; `uw plan`
   and `uw validate` name any still running), `uw plan … --sights sights,food,daytrips --force` with the sights that
   landed (the layers that exist; one not found stays out, in the reply's unverified line): places land on the
   stop's full days with their source links, and each such day's text says what it is for ("Livraria Lello (the
   1906 bookshop) · Eat: Mercado do Bolhão"). Reword a text in the traveller's words if you like (≤ 140 characters,
   nothing its pages do not say; no opening hours or prices from memory); a day still "Day in …" needs places.
2. **Train times**, if a timetable page answers it this turn: re-run `uw legs` with `--durations`/`--source`/
   `--source-url`, then `uw plan … --force` (re-add the day texts). Copy the page's own number; a page that gives a
   range ("2 to 3 h") stays a range (`--durations "2h–3h"`), never a midpoint. The operator's timetable or journey
   planner first; a travel guide (Wikivoyage) only when none answers, with `--source "about, per <guide>"`. `legs`
   reads each page again and drops a time it does not state (it prints what the page says): copy that, or leave it.
3. Only when `instafy preview check` was not available or flagged a problem: `uw snapshot <site> --signal` and look
   at the PNGs. A clean preview check is the visual check; do not repeat it, and never run git in the site folder.
4. Optional, if time is left: licence chips on the stays where a lodging register covers the area (`uw adapter
   list --at <lng,lat>`), doorstep photos (`uw photos <site> --layer stays`), what the region file suggests.

## Research-team handoff (big trips)

When the turn was planned as a research team, workers leave `handoff/<task-slug>/<item-slug>.json` files
(`"schema": "instafy.research@1"`: `item`, `kind` city|product, `summary`, `facts[]` with `source_url` and
`confidence`, `places[]` with `name`, `query`, `kind` hotel|station|sight|food|store, `why`, `source_url` and, for a
lane that covered several stops, `stop`; `legs[]` with `from`, `to`, `mode`, optional `duration_min` (or
`duration_min_range` [lo, hi]) and `source_url`; `unknowns[]`). After `uw new` (step 1), ONE command builds the map:

`uw handoff handoff/<task-slug> --site <site> --apply --detach --route "Porto:3,Lisbon:4" --start 2027-05-07`

It takes several minutes, so it runs as a job: then `uw wait` (prints its output; exit 75 = still running: run
`uw wait` again; never start it twice, never patch the map by hand while it runs). The card is out since step 1,
before the job, so slow lookups cannot end the turn with no card. SKILL.md step 9 comes once the job is done. Each stop is looked up in the
country its handoff file names (`--country` for files without one). It checks every file, re-reads the cited pages (a
place its page does not name loses that source), then runs steps 2-5 itself: per city the station (or the city
centre when no station is found, said in the unverified list; a stop neither placed is tried once more after the
stays), the stays (also in town when the station is far out;
`--centre-stays always|never` overrides), the researched hotels (the pick that matches takes the researcher's reason
and source and becomes the base; one no pick matches is placed only by its own name), the sourced sights, the track,
the legs with sourced durations, the question and the plan. It prints facts per stop (nights, researched sights, the
station's distance from the centre) and per leg (distance, sourced duration, a high-speed line near both ends or not),
the facts for day texts and the unverified list. The route is saved as the map's "expect" first. Exit 3 = a
requested stop is still not on the map: the report starts and ends with `REQUESTED BUT NOT ON THE MAP: <stops and
nights>` and the commands that place them; run them before anything else (`reference/several-stops.md` step 6),
never reply with the shorter route as if it were the trip. The researched sights and food (with the researcher's `why`) are
on the map and in the plan, so the full days already say what they are for. Sights it lists as not on the map
because the place lookup was unavailable come with their exact commands: run them, one per command (then, once each
has finished, `uw plan … --force`), before the reply when the turn clock allows; a sight still not placed goes into
its day's text with its source link. A full day never ships empty. Then act on the facts: a stop with full
days and no researched sights gets 2-3 sourced ones a full day (Phase B step 1, then `uw plan … --force`); a far station: say
where it is; a leg of about 100 km or more with a high-speed line at both ends: consider its HSR stations (`several-stops.md`
step 2), with "no": conventional train, never mention HSR. Reword day texts with the printed facts where they add
something, `uw validate --signal`, the preview (`several-stops.md` step 6), the reply. Without
`--apply` it only prints the same steps as commands.
- Coordinates never come from a handoff (it has none): every place goes through `station`, `stay` or `add-point`.
- Names and claims are copied, never improved: a place keeps the name its page gives ("Anping Fort"), and "by the
  station" or "the station-side branch" stands only where a page or `uw stay`'s walk says so.
- `facts[]` with high/medium confidence: day texts (with the fact's source). Low confidence and `unknowns[]`: not on
  the map; they go in the reply's "unverified" line.

## Later changes to a trip

A follow-up ("make it calmer", "dig deeper for every city", "a day trip from each base", "food spots") edits the
open site in place; then `uw validate`, SKILL.md step 9, the reply.
- A day's `text` sums up its items; it is never copied into an item. When you rewrite a day, rewrite or remove its
  items in the same edit, so no item contradicts the new text (`uw validate` warns about an item that repeats a
  day's text).
- Places you recommend (a food spot, a day-trip destination, a transfer point) go on the map, each with the page
  that names it, read with `uw cite <page> --grep "<its name>"` (`uw add-point` refuses a page it did not read):
  `uw add-point <site> --layer food|daytrips|sights --query "<local name>" --country "<Country>"
  --strict-name --near <base lng,lat> --props-file - <<'JSON'`, then `{"stop":"<station id>","source_url":"https://…","source":"<site>"}`
  and `JSON` on their own lines (a day trip adds `--max-km 80`; put the page's reason in `"why"`), then into the day as `{"text": "…", "ref":
  {"layer": "food", "id": "…"}, "url": "…"}` and rewrite that day's text to include it. Many days at once:
  `uw plan … --sights sights,food,daytrips --force` places them and rewrites the texts (hand edits are replaced).
  Prose items are only for how to get there.
- A note for a day ("add a note to day 1: book the tickets ahead"): `uw set <site> plan:day1 --note "<the note>"`,
  the day's own line under its text in the Plan tab (`--note ""` takes it off; `uw plan --force` keeps it). Never
  on a place or the stop: their notes show on their cards, not in the day.
- When the ask is per base, per city or per day, check every one against it before replying, and say which got
  nothing and why.
- The departure day keeps its plan text unless you have something sourced for it.
- Moving a place to another day: move its item and reword both days' texts in the same edit (never `uw plan
  --force` for it: it groups the days by area again, which undoes the move); `uw validate` says when a day's places
  are far apart or one is nearer another day's.
- Dropping a place: `uw set <site> <layer>:<id> --remove`, then remove its item and reword its day's text.
- Rail track still missing (the legs are arcs): run the lines/legs retry first (`reference/several-stops.md` step 4).
- Changing a place's note or reason: keep its sourced facts (the walk, the register line) and add to them; never
  replace them with an "unverified" paragraph (that goes in the reply's unverified line).
- Swapping a stop when a lookup exits 4: keep the current stop, say the place lookup is busy and that they can ask
  for the swap again; never half-swap.
- Quiet nights, light sleepers, "which hotel is quietest": answer on the open site in the same turn from what can be
  measured, per base: `uw feel <site> --around stays`, then `uw enrich <site> --layer stays --feel` (each stay's
  `calm_night` and `noise_night_db`, estimates at its door). Pick the calmest by that measure and say why in place terms (side street or main road, distance from the tracks), suggest asking for a high,
  street-away room, and reply with "Assumed: quiet from street and rail surroundings, not guest reviews". Review and
  booking sites refuse automated reads: never fan out to retry them; never a bare "can't confirm".

## Reply (Phase C for trips)

Write for the traveller, 5-8 short lines:
1. The route with nights and dates, as `uw plan` prints it ("Route for the reply"; one stop: "Stay for the reply"):
   `<Stop> <nights> → <Stop> <nights> → … (<n> nights, <first date> – <last date>)`. The night split is part of the
   answer: always state it.
   Check it against the stops asked for (step 0): one that is not on the map is named right after the route, with its
   nights and why ("<Stop> (2 nights) is not on the map yet: the place lookup was down; ask me to add it").
2. The `Assumed:` line from step 0: only what you filled in, the dates too when the person gave none.
3. Where to sleep: one stay per stop with its reason (name, walk to the station, and what a page said about it),
   e.g. `Porto: Hotel X (4 min walk from São Bento, quiet side street)`; where the base is not a walk from the
   station, say how far and how ("Taitung: Hotel Y, 6 km from the station: taxi or local bus"), as the plan does.
4. Trains: what is sourced (durations with their timetable) and what is an estimate from the distance (the plan
   says "about 2 h … (estimate …)"; "check the operator's timetable, linked on each leg").
5. Day highlights or warnings worth acting on (a closure, a pass to buy), only from the pages you opened; a full
   day still with one place to see when the time ran out (`uw validate` names it then): say which, and offer to add
   more.
6. `Sources:` in one line, by who publishes the data (e.g. "OpenStreetMap, Wikivoyage, the national park's site",
   the lodging register when one was used, plus the operator's journey planner when `uw transit` gave times).
7. `Unverified:` prices and availability (never checked), train times not sourced, anything "Not found yet",
   handoff unknowns.

Never in the reply: file or folder names (not the handoff or site folder either: "Research details: handoff/…" helps
nobody), command names, lookup services (Overpass, Photon, OSRM) or exit codes, layer ids (`stays:…`),
"validates"/"valid", internal scores, where the map is ("available in the Studio preview": its card shows under the
reply). A lookup that was busy is said in plain words ("the place search was busy"). A builder's final summary
follows the same rule: the lead copies it.
