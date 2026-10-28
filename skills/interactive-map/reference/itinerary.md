# Trips: stops, stations, stays, trains, days

On a turn that plans a research team (its skill is loaded and the trip meets its threshold), do not build: emit
the plan; the builder lane follows this file later.

Use this for an itinerary: two or more places with nights ("3 nights Taipei, then Hualien…", "10 days in Japan with
hotels and trains", "a rail loop with places to stay"), or days in one place ("3 days in Lisbon": "One base" below).
It replaces steps 4-8 of SKILL.md; the hard rules, the
preview step and the turn clock stay. It works anywhere: where an open-data adapter covers the area (`uw adapter list
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
`uw new <site> --title "<Country> by train" --subtitle "7–14 May · 7 nights" --ask "<the question in your words, ≤ 60 characters>" --center <lng,lat> --zoom 7 --expect "<Stop>:<nights>,…"`
(the ask is the map's heading, e.g. "Two weeks in Taiwan by train": never the user's message pasted in; `--expect`
is the route from step 0: every stop the user named or you chose, so `uw validate` fails while one is missing).

**2. One station per stop**, in travel order (a stop visited twice is added once):
`uw station <site> --city "<City>" --country "<Country>" --nights N` (it finds the city centre itself, in that
country: many city names exist in several countries; Photon, OpenStreetMap railway stations only, so a weather
station or bus stop never wins). Read the pick and the alternatives; `--pick N` takes another. A `FAR FROM THE
CENTRE` line (more than about 15 min walk): for a stop with full days, also find stays in town (the printed command)
and tell the traveller where the station is.
High-speed rail only where it pays: a leg of roughly 100 km or more where a high-speed line serves both ends (the
`rail` layer shows it; `uw handoff --apply` prints it per leg). Then an HSR station outside town gets its own
pass-through stop: `uw station <site> --city "<City>" --country "<Country>" --kind hsr --id <city>-hsr --nights 0`
(exit 2 = no HSR station by that name: try the station's own name). No high-speed line at either end: conventional
train, and never mention HSR. Neighbouring cities (Porto–Braga, Osaka–Kyoto) take the conventional train between the
two city stations: never route a short hop out to an HSR station and back.

**3. Stays by the station**, per stop: `uw stay <site> --near stations:<id>` (3 picks within 800 m, ranked by walking
time, each with a reason in plain words: "3 min walk to Porto São Bento · hotel"; a route that goes round the station
is replaced by the straight-line estimate, "about 3 min walk"; how each part is known is on the card, under "How we
know"). Where a lodging register covers the
area it comes first (licensed, open listings); elsewhere OpenStreetMap hotels, hostels and guest houses. Pass
`--kinds hotel` unless the user asked for hostels or said the budget is tight (an unknown party counts as hotels);
travellers who want character or a small place `--prefer any` (no penalty for B&Bs and small hotels). Call each
pick by the kind it was written with: a hostel is a hostel, in the reply too. Small towns: `--radius 1500`.
A station far from the centre (step 2): `uw stay <site> --near <centre lng,lat> --near-label "the centre of <City>"
--stop <station id>` too, and let the reply say which is which. Exit 2 = nothing in range: widen it. Never say a stay
is available, bookable or a price (a register's filed rates are not prices).
Give each pick one reason beyond the walk when a page you opened says it (quiet street, river view, family rooms).

**4. Real track, then the legs on it.**
`uw fit <site>`, `uw lines <site> --layer rail --kinds rail,hsr --simplify 80`, then
`uw legs <site> --layer trip --stops stations:a,stations:b,…,stations:a --modes train,…,hsr --follow rail --source-url "<timetable page per leg>"`.
Legs follow the OpenStreetMap track (no straight lines over mountains; the card says "194 km by rail"). A country
or a long trip is fetched as map tiles kept in a cache every site shares, so a busy Overpass costs only the tiles it
did not answer: `PARTIAL: rail track for 2 of 9 map tiles did not load` still writes the rest, and the line it prints
fetches only the missing tiles. A leg it could not put on the track stays an arc and its card says "Drawn straight"
(track not loaded / no connected track): say so in the reply, never its distance as a route. `lines` skipped (exit
4, no tile loaded): run `legs` anyway (arcs, labelled) and make "lines with `--timeout 180`, then `legs` again"
Phase B's first step (`uw handoff --apply` retries once itself and prints both commands). Until that has worked,
every later turn that touches the route runs them first: straight arcs over mountains are not a route. Durations: only from a source you opened this turn (`--durations "2h10,,3h30" --source "TRA timetable"
--source-url …`, empty = unknown); otherwise leave them out and the plan says "times: check the timetable" with the
link. A journey planner gives them per leg when one is configured:
`uw transit <site> --from stations:a --to stations:b --date <travel day>` prints a typical ride time with its
`source`/`source_url` (exit 4 = no planner configured: no durations, move on). Say "about": times are scheduled.
Operator pages: the operator's journey planner (DB, SNCF, Trenitalia, Renfe, NS, JR, Amtrak…; a region file names
more).

**5. Question + plan.**
`uw question <site> --kind plan-route --options stations --force` (the heading "6 stops · 14 nights · 6 rides by
train & HSR"; the ask comes from `--ask`), then
`uw plan <site> --stops stations --ids a,b,…,a --nights 3,2,…,2 --start 2026-10-20 --legs trip --stays stays`:
one dated day per night plus the departure day, travel days with the leg and the new base, every day focused on that
stop's best stay. A 0-night stop shares its travel day ("Tainan → Tainan HSR → Taipei"). The departure day is marked
("Departure" on the map, "Leave <stop>."): nothing is planned on it; never fill it with places to look complete.

**6. Reconcile, then preview.** `uw validate <site> --signal`. It checks the map against the route ("expect"):
`asked for but not on the map: <Stop> (2 nights)` or `on the map but in no day of the plan` is an error. Place the
stop (the retry command `uw handoff --apply` or the lookup printed, with `--timeout 120`; else `uw add-point <site>
--layer stations --query "<City>" --country "<Country>" --kind city --allow-far --id <id> --props-file - <<'JSON'`, then
`{"nights":N,"station_of":"<City>","no_station":true}` and `JSON` on their own lines), then
`uw plan … --ids <every stop> --nights … --force`. Still not placed (exit 4 again): keep going, and the reply's route
line names it as missing with its nights ("<Stop> (2 nights) is not on the map yet: the place lookup was down"). Then preview (SKILL.md step 9): the card goes out before Phase B, so the traveller has the map while the days
fill in.

## Phase B: make it worth following (one step at a time, while the turn clock shows more than ~3 min left)

A plan whose full days say only "Day in …" is not finished. When the ask is what to see or do each day (a trip of
days: "3 days in Lisbon", "what to see each day"), build the plan with `--sights`: then `uw validate` fails while a
full day has no sourced place, as it fails for a stop asked for that is not on the map. Without `--sights` it warns
when most full days are empty, and the turn clock prints how many are empty or thin. While any is and time is left,
add sights rather than reply. Step 1 comes first.

1. **Sights with sources, 2-3 per city.** There is no search tool: start from the city's Wikivoyage page
   (`uw cite https://en.wikivoyage.org/wiki/<City> --grep "<what you need>"`, sections See/Do), then open the
   official tourism site, the attraction's own site, a national park or Wikipedia and check it is current (closures, renovations, seasonal hours). A refused site (it bans agents, robots.txt, a bot
   check) is a plain link, never fetched another way. At most about 8 pages per city. Then per sight:
   ```
   uw add-point <site> --layer sights --query "<local-language name>" --country "<Country>" --strict-name --near <that station's lng,lat> --id <slug> --props-file - <<'JSON'
   {"stop":"<station id>","source_url":"https://…","source":"<site name>","why":"<what the page says to do there>"}
   JSON
   ```
   (props with words in them always go on stdin like this: an apostrophe in single-quoted JSON breaks the command;
   exit 2 = no hit carries the name: retry once with the local name, else list it as unverified; food spots go on
   `--layer food`, day trips on `--layer daytrips --max-km 80`).
   Then `uw plan … --sights sights,food,daytrips --force` (the layers that exist): places land on the stop's full
   days with their source links, and each such day's text says what it is for ("Livraria Lello (the 1906
   bookshop) · Eat: Mercado do Bolhão"). Reword a text in the traveller's words if you like (≤ 140 characters,
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

## One base: days in one place

"3 days in Lisbon", "a weekend in Kyoto", "a day in Porto": one stop and no trains. Step 0 (parse, defaults, the
`Assumed:` line), step 1, step 6 and Phase B stay; instead of steps 2-5:

1. **The stop** is the city: `uw add-point <site> --layer stops --query "<City>" --country "<Country>" --kind city --id <slug>
   --props '{"nights":N}'`. "N days" is N nights (they leave the day after) unless the user gave dates; one day is 0.
2. **Stays** in the area you recommend staying in (a page you read says why): `uw geocode "<area>, <City>"`, then
   `uw stay <site> --near <its lng,lat> --near-label "<area>" --stop <slug>` (step 3's rules: hotels unless asked,
   a reason each). The base is the rank-1 stay; each day starts and ends there. Never the area itself as a hotel. No
   stay found (exit 2 after widening, or exit 4): pin the area as the recommendation, labelled as one:
   `uw add-point <site> --layer stays --query "<area>, <City>" --kind area --id <area slug> --props-file - <<'JSON'`, then
   `{"stop":"<slug>","note":"Area to stay in: <why, from the page>"}` and `JSON` on their own lines (the days start
   there), and the reply says places to stay were not looked up yet.
3. **Places by area**, before the plan: per day an area worth the day (a neighbourhood, a district a ride away, a day
   trip), 2-3 sourced places in it (Phase B step 1, with `"stop":"<slug>"`). Never put a place on a day because a
   list had room. Every full day gets its places before the reply: `uw validate` fails while one has none.
4. **Plan**: `uw plan <site> --stops stops --ids <slug> --nights N --start <date> --stays stays --sights sights,food,daytrips`.
   Every day is a loop from the base: a stop's places are grouped by area (the closest share a day, in walking
   order, the area nearest the base first; the arrival day takes one when the other days would hold more than 2
   places each), then the departure day. Never "<city> →
   <city>": a stop named twice in a row is one stay. The reply says where to stay and why, then each day's area.

**Days that hang together.** `uw plan` and `uw validate` warn when a day has a place far from its other places, or
nearer another day's (`day places: "<place>" (<day>) is 3.1 km from that day's other places but 0.2 km from
"<place>" on <day>`). Move it to the day named, in the items and both days' texts, or rebuild with `uw plan … --force`
(it groups by area). A day trip far out of town is judged on its own.

## Research-team handoff (big trips)

When the turn was planned as a research team, workers leave `handoff/<task-slug>/<item-slug>.json` files
(`"schema": "instafy.research@1"`: `item`, `kind` city|product, `summary`, `facts[]` with `source_url` and
`confidence`, `places[]` with `name`, `query`, `kind` hotel|station|sight|food|store, `why`, `source_url` and, for a
lane that covered several stops, `stop`; `legs[]` with `from`, `to`, `mode`, optional `duration_min` (or
`duration_min_range` [lo, hi]) and `source_url`; `unknowns[]`). After `uw new` (step 1), ONE command builds the map:

`uw handoff handoff/<task-slug> --site <site> --apply --detach --route "Porto:3,Lisbon:4" --start 2027-05-07`

It takes several minutes, so it runs as a job: then `uw wait` (prints its output; exit 75 = still running: run
`uw wait` again; never start it twice, never patch the map by hand while it runs). Open the preview while it runs (SKILL.md step 9:
`uw host … --detach`, then `instafy preview open`), before the first `uw wait`: the card shows the map as it fills in,
so slow lookups cannot end the turn with no card (r11: a builder whose lookups were slow ran out of turn before
step 9). `instafy preview check` comes once the job is done. Each stop is looked up in the
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
nights>` and the commands that place them; run them before anything else (step 6), never reply with the shorter
route as if it were the trip. The researched sights and food (with the researcher's `why`) are
on the map and in the plan, so the full days already say what they are for. Sights it lists as not on the map
because the place lookup was unavailable come with their exact commands: run them (then `uw plan … --force`) before
the reply when the turn clock allows; a sight still not placed goes into its day's text with its source link. A full
day never ships empty. Then act on the facts: a stop with full
days and no researched sights gets 2-3 sourced ones (Phase B step 1, then `uw plan … --force`); a far station: say
where it is; a leg of about 100 km or more with a high-speed line at both ends: consider its HSR stations (step 2),
with "no": conventional train, never mention HSR. Reword day texts with the printed facts where they add something,
`uw validate --signal`, the preview (step 6), the reply. Without
`--apply` it only prints the same steps as commands.
- Coordinates never come from a handoff (it has none): every place goes through `station`, `stay` or `add-point`.
- Names and claims are copied, never improved: a place keeps the name its page gives ("Anping Fort"), and "by the
  station" or "the station-side branch" stands only where a page or `uw stay`'s walk says so.
- `facts[]` with high/medium confidence: day texts (with the fact's source). Low confidence and `unknowns[]`: not on
  the map; they go in the reply's "unverified" line.

## Later changes to a trip

A follow-up ("make it calmer", "dig deeper for every city", "a day trip from each base", "food spots") edits the
open site in place; then `uw validate`, `uw reload`, the reply.
- A day's `text` sums up its items; it is never copied into an item. When you rewrite a day, rewrite or remove its
  items in the same edit, so no item contradicts the new text (`uw validate` warns about an item that repeats a
  day's text).
- Places you recommend (a food spot, a day-trip destination, a transfer point) go on the map, each with the page
  that names it: `uw add-point <site> --layer food|daytrips|sights --query "<local name>" --country "<Country>"
  --strict-name --near <base lng,lat> --props-file - <<'JSON'`, then `{"stop":"<station id>","source_url":"https://…","source":"<site>"}`
  and `JSON` on their own lines (a day trip adds `--max-km 80`; put the page's reason in `"why"`), then into the day as `{"text": "…", "ref":
  {"layer": "food", "id": "…"}, "url": "…"}` and rewrite that day's text to include it. Many days at once:
  `uw plan … --sights sights,food,daytrips --force` places them and rewrites the texts (hand edits are replaced).
  Prose items are only for how to get there.
- When the ask is per base, per city or per day, check every one against it before replying, and say which got
  nothing and why.
- The departure day keeps its plan text unless you have something sourced for it.
- Moving a place to another day: move its item and reword both days' texts in the same edit; `uw validate` says
  when a day's places are far apart or one is nearer another day's.
- Rail track still missing (the legs are arcs): run the lines/legs retry first (Phase A step 4).
- Changing a place's note or reason: keep its sourced facts (the walk, the register line) and add to them; never
  replace them with an "unverified" paragraph (that goes in the reply's unverified line).
- Swapping a stop when a lookup exits 4: keep the current stop, say "place lookup is busy" and offer "Do the swap"
  as a one-tap follow-up; never half-swap.
- Quiet nights, light sleepers, "which hotel is quietest": answer on the open site in the same turn from what can be
  measured, per base: `uw feel <site> --around stays`, then `uw enrich <site> --layer stays --feel` (each stay's
  `calm_night` and `noise_night_db`, estimates at its door). Pick the calmest by that measure and say why in place terms (side street or main road, distance from the tracks), suggest asking for a high,
  street-away room, and reply with "Assumed: quiet from street and rail surroundings, not guest reviews" plus one-tap
  follow-ups. Review and booking sites refuse automated reads: never fan out to retry them; never a bare "can't
  confirm".

## Reply (Phase C for trips)

Write for the traveller, 5-8 short lines:
1. The route with nights and dates, as `uw plan` prints it ("Route for the reply"): `<Stop> <nights> → <Stop>
   <nights> → … (<n> nights, <first date> – <last date>)`. The night split is part of the answer: always state it.
   Check it against the stops asked for (step 0): one that is not on the map is named right after the route, with its
   nights and why ("<Stop> (2 nights) is not on the map yet: the place lookup was down; ask me to add it").
2. The `Assumed:` line from step 0 (only what you filled in).
3. Where to sleep: one stay per stop with its reason (name, walk to the station, and what a page said about it),
   e.g. `Porto: Hotel X (4 min walk from São Bento, quiet side street)`; where the base is not a walk from the
   station, say how far and how ("Taitung: Hotel Y, 6 km from the station: taxi or local bus"), as the plan does.
4. Trains: what is sourced (durations with their timetable) and what is an estimate from the distance (the plan
   says "about 2 h … (estimate …)"; "check the operator's timetable, linked on each leg").
5. Day highlights or warnings worth acting on (a closure, a pass to buy), only from the pages you opened.
6. `Sources:` in one line, by who publishes the data (e.g. "OpenStreetMap, Wikivoyage, the national park's site",
   the lodging register when one was used, plus the operator's journey planner when `uw transit` gave times).
7. `Unverified:` prices and availability (never checked), train times not sourced, anything "Not found yet",
   handoff unknowns.
8. "Open it from the card." (SKILL.md step 9).

Never in the reply: file or folder names (not the handoff or site folder either: "Research details: handoff/…" helps
nobody), command names, lookup services (Overpass, Photon, OSRM) or exit codes, layer ids (`stays:…`),
"validates"/"valid", internal scores. A lookup that was busy is said in plain words ("the place search was busy"). A builder's final summary
follows the same rule: the lead copies it.
End with 2-3 one-tap follow-ups that change what you assumed or add a next step ("We're 4, with kids", "Slower
pace", "Add a day trip"); never a question the user must answer before the plan exists. In Instafy they go in
`suggestions`: a plain-text reply ends with a fenced block tagged `suggestions`, one per line.
