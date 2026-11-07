# Several stops: stations, stays, trains (trip steps 2-6)

Two or more places with nights. These steps follow steps 0-1 of `reference/itinerary.md` (days in one place take its
"One base" instead), and its Phase B and "Reply" follow step 6.

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
time, each with a reason in plain words: "3 min walk to Porto São Bento"; a route that goes round the station
is replaced by the straight-line estimate, "about 3 min walk"; how each part is known is on the card, under "How we
know"). Where a lodging register covers the
area it comes first (licensed, open listings); elsewhere OpenStreetMap hotels, hostels and guest houses. Pass
`--kinds hotel` unless the user asked for hostels or said the budget is tight (an unknown party counts as hotels);
travellers who want character or a small place `--prefer any` (no penalty for B&Bs and small hotels). Call each
pick by the kind it was written with: a hostel is a hostel, in the reply too. A hotel in range is always among the
picks; "No hotel within …" means there is none, and the reply says so. Small towns: `--radius 1500`.
It answers within about 30 s with what it found (a busy lookup gives fewer, marked partial; exit 4 = none found:
say places to stay were not looked up yet): wait for it, never run it twice.
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
line names it as missing with its nights ("<Stop> (2 nights) is not on the map yet: the place lookup was down"). Then SKILL.md step 9 (open viewers update, the card's picture is refreshed), before Phase B: the traveller has
the map while the days fill in.
